"use server";

import { requireRole } from "@/lib/dal";
import { db } from "@/lib/db";
import { dedupeExternalId, emitAgentEvent } from "@/lib/emit-agent-event";
import { Client } from "@upstash/workflow";
import { env } from "@/lib/env";
import { updateTag } from "next/cache";
import { approvalActionLimiter } from "@/lib/rate-limit";
import { approvalDecisionDedupeKey, approvalEventId } from "@/lib/proposal";

const workflowClient = new Client({ token: env.QSTASH_TOKEN });

type ApprovalResult = { ok: true } | { ok: false; error: string };
type ProposalPayload = {
  proposalId: string;
  workflowRunId: string;
  action: string;
  riskLevel: "low" | "medium" | "high";
};

function parseProposalPayload(value: unknown): ProposalPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (
    payload.type !== "action_proposed" ||
    typeof payload.proposalId !== "string" ||
    typeof payload.workflowRunId !== "string" ||
    typeof payload.action !== "string" ||
    !["low", "medium", "high"].includes(String(payload.riskLevel))
  ) {
    return null;
  }
  return {
    proposalId: payload.proposalId,
    workflowRunId: payload.workflowRunId,
    action: payload.action,
    riskLevel: payload.riskLevel as ProposalPayload["riskLevel"],
  };
}

export async function respondToProposedAction(
  incidentId: string,
  orgId: string,
  proposalId: string,
  approved: boolean,
): Promise<ApprovalResult> {
  try {
    const { userId } = await requireRole(orgId, ["COMMANDER"]);

    // The approval limiter is defense-in-depth, not the authorization boundary.
    // If Redis is unavailable, preserve the Commander's human decision path.
    let approvalCheck: { success: boolean } | undefined;
    try {
      approvalCheck = await approvalActionLimiter.limit(userId);
    } catch (error) {
      console.error("[approval-rate-limit] Limiter unavailable; preserving human approval availability.", error);
    }

    if (approvalCheck && !approvalCheck.success) {
      return { ok: false, error: "Too many approval actions. Please wait a moment and try again." };
    }

    const incident = await db.incident.findFirst({
      where: { id: incidentId, orgId },
      select: { workflowRunId: true, status: true },
    });
    if (!incident?.workflowRunId) {
      return { ok: false, error: "No pending workflow found for this incident." };
    }
    if (incident.status !== "AWAITING_APPROVAL") {
      return { ok: false, error: "This incident is no longer awaiting approval." };
    }

    const latestProposalEvent = await db.event.findFirst({
      where: { orgId, incidentId, type: "action_proposed" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { payload: true },
    });
    const proposal = parseProposalPayload(latestProposalEvent?.payload);
    if (
      !proposal ||
      proposal.proposalId !== proposalId ||
      proposal.workflowRunId !== incident.workflowRunId
    ) {
      return { ok: false, error: "This proposal is stale. Refresh the incident before deciding." };
    }

    const decisionType = approved ? "action_approved" : "action_rejected";
    const decisionKey = approvalDecisionDedupeKey(proposalId);
    const created = await emitAgentEvent(
      orgId,
      incidentId,
      { type: decisionType, actorId: userId, proposalId, ts: Date.now() },
      { dedupeKey: decisionKey },
    );

    if (!created) {
      // The unique (orgId, externalId) constraint arbitrates concurrent approve/reject
      // requests. A retry of the same decision can safely re-notify; a conflicting
      // decision loses and must never reach the workflow.
      const existing = await db.event.findFirst({
        where: { orgId, incidentId, externalId: dedupeExternalId(incidentId, decisionKey) },
        select: { type: true, payload: true },
      });
      const existingPayload = existing?.payload;
      const existingProposalId =
        existingPayload && typeof existingPayload === "object" && !Array.isArray(existingPayload)
          ? (existingPayload as Record<string, unknown>).proposalId
          : undefined;

      if (existing?.type !== decisionType || existingProposalId !== proposalId) {
        return { ok: false, error: "A different decision has already been recorded for this proposal." };
      }
    }

    await workflowClient.notify({
      eventId: approvalEventId(incidentId, proposalId),
      eventData: { approved, proposalId },
      workflowRunId: incident.workflowRunId,
    });

    updateTag(`incidents-${orgId}`);
    return { ok: true };
  } catch (error) {
    console.error("[approval] Failed to submit a proposal decision.", error);
    return { ok: false, error: "Unable to submit your decision. Please try again." };
  }
}
