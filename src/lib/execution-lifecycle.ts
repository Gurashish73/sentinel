import "server-only";

import { revalidateTag } from "next/cache";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { dedupeExternalId, workflowEventDedupeKey } from "@/lib/emit-agent-event";

export type ApprovedProposal = {
  proposalId: string;
  workflowRunId: string;
  action: string;
  riskLevel: "low" | "medium" | "high";
};

export type ExecutionClaimResult = "claimed" | "already_executed" | "superseded";
export type ExecutionCompletionResult = "completed" | "superseded";

type EventIdentity = {
  type: string;
  payload: unknown;
};

function payloadMatchesProposal(event: EventIdentity | null, type: string, proposal: ApprovedProposal) {
  if (!event || event.type !== type || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    return false;
  }

  const payload = event.payload as Record<string, unknown>;
  return (
    payload.type === type &&
    payload.proposalId === proposal.proposalId &&
    payload.workflowRunId === proposal.workflowRunId &&
    payload.action === proposal.action
  );
}

function claimKey(proposal: ApprovedProposal) {
  return workflowEventDedupeKey(proposal.workflowRunId, "execution", "claimed", proposal.proposalId);
}

function executionKey(proposal: ApprovedProposal) {
  return workflowEventDedupeKey(proposal.workflowRunId, "execution", "executed", proposal.proposalId);
}

async function findCurrentIncident(
  tx: Prisma.TransactionClient,
  incidentId: string,
  orgId: string,
  workflowRunId: string,
) {
  return tx.incident.findFirst({
    where: { id: incidentId, orgId, workflowRunId },
    select: { status: true },
  });
}

async function findEventByExternalId(
  tx: Prisma.TransactionClient,
  orgId: string,
  incidentId: string,
  key: string,
): Promise<EventIdentity | null> {
  const row = await tx.event.findUnique({
    where: { orgId_externalId: { orgId, externalId: dedupeExternalId(incidentId, key) } },
    select: { type: true, payload: true },
  });
  return row;
}

/**
 * Atomically claims a proposal for execution. The incident state and the claim
 * event commit together, so neither can be persisted without the other.
 * Replaying this operation for the same proposal is safe.
 */
export async function claimApprovedExecution(input: {
  incidentId: string;
  orgId: string;
  proposal: ApprovedProposal;
}): Promise<ExecutionClaimResult> {
  const { incidentId, orgId, proposal } = input;
  const claimExternalId = dedupeExternalId(incidentId, claimKey(proposal));
  const executedKey = executionKey(proposal);
  let changed = false;

  const result = await db.$transaction(async (tx) => {
    const current = await findCurrentIncident(tx, incidentId, orgId, proposal.workflowRunId);
    if (!current) return "superseded" as const;

    const existingExecution = await findEventByExternalId(tx, orgId, incidentId, executedKey);
    if (existingExecution) {
      return payloadMatchesProposal(existingExecution, "action_executed", proposal) && current.status === "RESOLVED"
        ? "already_executed" as const
        : "superseded" as const;
    }

    const existingClaim = await findEventByExternalId(tx, orgId, incidentId, claimKey(proposal));
    if (existingClaim) {
      return payloadMatchesProposal(existingClaim, "action_execution_claimed", proposal) && current.status === "EXECUTING"
        ? "claimed" as const
        : "superseded" as const;
    }

    // If the initial read already shows a state that cannot be claimed, avoid
    // an unnecessary compare-and-set write. The conditional update below is
    // still required to protect against changes that happen after this read.
    if (current.status !== "AWAITING_APPROVAL") return "superseded" as const;

    const moved = await tx.incident.updateMany({
      where: {
        id: incidentId,
        orgId,
        workflowRunId: proposal.workflowRunId,
        status: "AWAITING_APPROVAL",
      },
      data: { status: "EXECUTING" },
    });

    if (moved.count !== 1) {
      // A concurrent delivery may have claimed the same proposal after our first
      // read. Re-read within this transaction and resume only for that exact claim.
      const refreshed = await findCurrentIncident(tx, incidentId, orgId, proposal.workflowRunId);
      const racedClaim = await findEventByExternalId(tx, orgId, incidentId, claimKey(proposal));
      if (racedClaim && payloadMatchesProposal(racedClaim, "action_execution_claimed", proposal) && refreshed?.status === "EXECUTING") {
        return "claimed" as const;
      }
      const racedExecution = await findEventByExternalId(tx, orgId, incidentId, executedKey);
      if (racedExecution && payloadMatchesProposal(racedExecution, "action_executed", proposal) && refreshed?.status === "RESOLVED") {
        return "already_executed" as const;
      }
      return "superseded" as const;
    }

    await tx.event.create({
      data: {
        orgId,
        incidentId,
        type: "action_execution_claimed",
        payload: {
          type: "action_execution_claimed",
          proposalId: proposal.proposalId,
          workflowRunId: proposal.workflowRunId,
          action: proposal.action,
          riskLevel: proposal.riskLevel,
          ts: Date.now(),
        },
        actorId: null,
        externalId: claimExternalId,
      },
    });

    changed = true;
    return "claimed" as const;
  });

  if (changed) revalidateTag(`incidents-${orgId}`, { expire: 0 });
  return result;
}

/**
 * For the current simulated executor, recording action_executed is the execution
 * side effect. The RESOLVED transition and the event are committed in one
 * transaction. A retry sees the prior event and does not emit a duplicate.
 */
export async function completeApprovedExecution(input: {
  incidentId: string;
  orgId: string;
  proposal: ApprovedProposal;
}): Promise<ExecutionCompletionResult> {
  const { incidentId, orgId, proposal } = input;
  const key = executionKey(proposal);
  const externalId = dedupeExternalId(incidentId, key);
  let changed = false;

  const result = await db.$transaction(async (tx) => {
    const current = await findCurrentIncident(tx, incidentId, orgId, proposal.workflowRunId);
    if (!current) return "superseded" as const;

    const existing = await findEventByExternalId(tx, orgId, incidentId, key);
    if (existing) {
      return payloadMatchesProposal(existing, "action_executed", proposal) && current.status === "RESOLVED"
        ? "completed" as const
        : "superseded" as const;
    }

    const moved = await tx.incident.updateMany({
      where: {
        id: incidentId,
        orgId,
        workflowRunId: proposal.workflowRunId,
        status: "EXECUTING",
      },
      data: { status: "RESOLVED" },
    });

    if (moved.count !== 1) {
      // Recover the case where another delivery committed the exact same outcome.
      const refreshed = await findCurrentIncident(tx, incidentId, orgId, proposal.workflowRunId);
      const racedExecution = await findEventByExternalId(tx, orgId, incidentId, key);
      return racedExecution && payloadMatchesProposal(racedExecution, "action_executed", proposal) && refreshed?.status === "RESOLVED"
        ? "completed" as const
        : "superseded" as const;
    }

    await tx.event.create({
      data: {
        orgId,
        incidentId,
        type: "action_executed",
        payload: {
          type: "action_executed",
          proposalId: proposal.proposalId,
          workflowRunId: proposal.workflowRunId,
          action: proposal.action,
          result: { note: "This is a demo action, not a real infrastructure change." },
          ts: Date.now(),
        },
        actorId: null,
        externalId,
      },
    });

    changed = true;
    return "completed" as const;
  });

  if (changed) revalidateTag(`incidents-${orgId}`, { expire: 0 });
  return result;
}
