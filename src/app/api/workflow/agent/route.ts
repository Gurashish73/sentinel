import { serve } from "@upstash/workflow/nextjs";
import { db } from "@/lib/db";
import { runTriage } from "@/agents/triage";
import { runDiagnosis } from "@/agents/diagnosis";
import { proposeRemediation } from "@/agents/remediation";
import { transitionIncidentWithEvent } from "@/lib/incident-transition";
import {
  dedupeExternalId,
  emitAgentEvent,
  workflowEventDedupeKey,
} from "@/lib/emit-agent-event";
import { orgExecutionLimiter } from "@/lib/rate-limit";
import { approvalEventId } from "@/lib/proposal";
import {
  claimApprovedExecution,
  completeApprovedExecution,
} from "@/lib/execution-lifecycle";
import type { AgentEvent } from "@/lib/event";

type Payload = {
  incidentId: string;
  orgId: string;
  attemptToken?: string;
};

export const { POST } = serve<Payload>(
  async (context) => {
    const { incidentId, orgId, attemptToken } = context.requestPayload;

    // Stable across retries of this durable workflow. A new workflow run
    // gets a new namespace.
    const workflowRunId = context.workflowRunId;

    const emitOnce = (event: AgentEvent, name: string) =>
      emitAgentEvent(orgId, incidentId, event, {
        dedupeKey: workflowEventDedupeKey(
          workflowRunId,
          "workflow",
          name,
        ),
      });

    const finish = (
      reason: Extract<AgentEvent, { type: "workflow_finished" }>["reason"],
    ) =>
      emitOnce(
        {
          type: "workflow_finished",
          workflowRunId,
          reason,
          ts: Date.now(),
        },
        `finished:${reason}`,
      );

    // Claim workflow ownership before the agent pipeline runs. This also
    // closes the trigger race: either the trigger or this step may persist
    // workflowRunId first.
    const startup = await context.run(
      "mark-investigating",
      async () => {
        const claimed = await db.incident.updateMany({
          where: {
            id: incidentId,
            orgId,
            workflowAttemptToken: attemptToken ?? null,
            status: { in: ["OPEN", "INVESTIGATING"] },
            OR: [{ workflowRunId: null }, { workflowRunId }],
          },
          data: {
            status: "INVESTIGATING",
            workflowRunId,
          },
        });

        if (claimed.count === 1) return "started" as const;

        const current = await db.incident.findFirst({
          where: { id: incidentId, orgId },
          select: {
            status: true,
            workflowRunId: true,
            workflowAttemptToken: true,
          },
        });

        if (
          !current ||
          current.workflowRunId !== workflowRunId ||
          current.workflowAttemptToken !== (attemptToken ?? null)
        ) {
          return "superseded" as const;
        }

        if (
          current.status === "INVESTIGATING" ||
          current.status === "AWAITING_APPROVAL"
        ) {
          return "started" as const;
        }

        return "completed" as const;
      },
    );

    if (startup === "superseded") {
      await context.run("finish-superseded-start", () =>
        finish("superseded"),
      );
      return;
    }

    if (startup === "completed") return;

    const incident = await context.run("load-incident", async () => {
      const current = await db.incident.findFirst({
        where: { id: incidentId, orgId, workflowRunId },
      });

      if (!current) {
        throw new Error("Incident is no longer owned by this workflow.");
      }

      return current;
    });

    const triage = await context.run("triage", () =>
      runTriage(incident, orgId, workflowRunId),
    );

    if (!triage.shouldInvestigate) {
      await context.run("mark-skipped", async () => {
        const moved = await db.incident.updateMany({
          where: {
            id: incidentId,
            orgId,
            workflowRunId,
            workflowAttemptToken: attemptToken ?? null,
            status: "INVESTIGATING",
          },
          data: { status: "OPEN" },
        });

        await finish(moved.count === 1 ? "skipped" : "superseded");
      });

      return;
    }

    const diagnosis = await context.run("diagnosis", () =>
      runDiagnosis(incident, orgId, workflowRunId),
    );

    const proposal = await context.run("propose-remediation", () =>
      proposeRemediation(
        incident,
        orgId,
        diagnosis,
        workflowRunId,
      ),
    );

    if (!proposal) {
      await context.run("no-proposal", async () => {
        const moved = await db.incident.updateMany({
          where: {
            id: incidentId,
            orgId,
            workflowRunId,
            workflowAttemptToken: attemptToken ?? null,
            status: "INVESTIGATING",
          },
          data: { status: "OPEN" },
        });

        await finish(moved.count === 1 ? "no_proposal" : "superseded");
      });

      return;
    }

    const { eventData, timeout } = await context.waitForEvent(
      "human-approval",
      approvalEventId(incidentId, proposal.proposalId),
      { timeout: "1d" },
    );

    if (timeout) {
      await context.run("mark-timed-out", async () => {
        const transition = await transitionIncidentWithEvent({
          incidentId,
          orgId,
          workflowRunId,
          fromStatus: "AWAITING_APPROVAL",
          toStatus: "OPEN",
          event: {
            type: "action_timed_out",
            ts: Date.now(),
          },
          dedupeKey: workflowEventDedupeKey(
            workflowRunId,
            "workflow",
            "action-timed-out",
          ),
        });

        await finish(
          transition === "transitioned" ? "timed_out" : "superseded",
        );
      });

      return;
    }

    const decision = (eventData ?? {}) as {
      approved?: unknown;
      proposalId?: unknown;
    };

    if (
      typeof decision.approved !== "boolean" ||
      decision.proposalId !== proposal.proposalId
    ) {
      await context.run("reject-mismatched-approval", async () => {
        const transition = await transitionIncidentWithEvent({
          incidentId,
          orgId,
          workflowRunId,
          fromStatus: "AWAITING_APPROVAL",
          toStatus: "OPEN",
          event: {
            type: "thought",
            text:
              "Approval did not match the current remediation proposal; no action was executed.",
            ts: Date.now(),
          },
          dedupeKey: workflowEventDedupeKey(
            workflowRunId,
            "workflow",
            "approval-mismatch",
          ),
        });

        await finish(
          transition === "transitioned"
            ? "approval_mismatch"
            : "superseded",
        );
      });

      return;
    }

    if (!decision.approved) {
      await context.run("record-rejection", async () => {
        const transition = await transitionIncidentWithEvent({
          incidentId,
          orgId,
          workflowRunId,
          fromStatus: "AWAITING_APPROVAL",
          toStatus: "OPEN",
          event: {
            type: "thought",
            text: "Remediation was rejected. Returning incident to OPEN state.",
            ts: Date.now(),
          },
          dedupeKey: workflowEventDedupeKey(
            workflowRunId,
            "workflow",
            "rejection-thought",
          ),
        });

        await finish(
          transition === "transitioned" ? "rejected" : "superseded",
        );
      });

      return;
    }

    // Runs after proposal-bound human approval and before execution.
    // Only serializable values are returned from this durable workflow step.
    const executionCheck = await context.run(
      "check-blast-radius",
      async () => {
        const { success, limit, remaining, reset } =
          await orgExecutionLimiter.limit(orgId);

        return { success, limit, remaining, reset };
      },
    );

    if (!executionCheck.success) {
      await context.run("block-on-blast-radius", async () => {
        const transition = await transitionIncidentWithEvent({
          incidentId,
          orgId,
          workflowRunId,
          fromStatus: "AWAITING_APPROVAL",
          toStatus: "ESCALATION_REQUIRED",
          event: {
            type: "blast_radius_exceeded",
            text:
              "Approved action blocked: organization execution limit reached. Manual operator review required.",
            ts: Date.now(),
          },
          dedupeKey: workflowEventDedupeKey(
            workflowRunId,
            "workflow",
            "blast-radius-exceeded",
          ),
        });

        await finish(
          transition === "transitioned"
            ? "blast_radius_exceeded"
            : "superseded",
        );
      });

      return;
    }

    // Atomically transition AWAITING_APPROVAL -> EXECUTING and persist
    // a proposal-bound claim event.
    const executionClaim = await context.run("claim-execution", () =>
      claimApprovedExecution({ incidentId, orgId, proposal }),
    );

    if (executionClaim === "superseded") {
      await context.run("finish-superseded-execution", () =>
        finish("superseded"),
      );
      return;
    }

    if (executionClaim === "already_executed") {
      await context.run("finish-recovered-execution", () =>
        finish("resolved"),
      );
      return;
    }

    // The current executor is intentionally simulated. The action audit
    // record and RESOLVED transition are committed transactionally.
    await context.run("execute-action", async () => {
      const outcome = await completeApprovedExecution({
        incidentId,
        orgId,
        proposal,
      });

      await finish(
        outcome === "completed" ? "resolved" : "superseded",
      );
    });
  },
  {
    failureFunction: async ({ context, failStatus }) => {
      const payload = context.requestPayload as
        | Partial<Payload>
        | null
        | undefined;

      const workflowRunId = context.workflowRunId;

      if (
        !payload ||
        typeof payload.incidentId !== "string" ||
        typeof payload.orgId !== "string"
      ) {
        console.error(
          "[workflow failure] Invalid workflow failure payload.",
          { workflowRunId, failStatus },
        );

        return;
      }

      const { incidentId, orgId } = payload;

      const attemptToken =
        typeof payload.attemptToken === "string"
          ? payload.attemptToken
          : undefined;

      console.error("[workflow failure] Workflow retries exhausted.", {
        incidentId,
        orgId,
        workflowRunId,
        failStatus,
      });

      const statusChangedExternalId = dedupeExternalId(
        incidentId,
        workflowEventDedupeKey(
          workflowRunId,
          "workflow",
          "failure-status-reset",
        ),
      );

      await db.$transaction(async (tx) => {
        const current = await tx.incident.findFirst({
          where: { id: incidentId, orgId },
          select: {
            status: true,
            workflowRunId: true,
            workflowAttemptToken: true,
          },
        });

        if (!current) return;

        // Reject legacy or stale deliveries when they do not own the
        // active fencing token.
        if (
          current.workflowAttemptToken !== (attemptToken ?? null)
        ) {
          return;
        }

        // Never modify an incident currently owned by another workflow run.
        if (
          current.workflowRunId !== null &&
          current.workflowRunId !== workflowRunId
        ) {
          return;
        }

        // A completed run must have at most one terminal workflow event.
        const existingFinishedEvent = await tx.event.findFirst({
          where: {
            orgId,
            incidentId,
            type: "workflow_finished",
            externalId: {
              startsWith:
                `sentinel-agent-event:${incidentId}:workflow:${workflowRunId}:workflow:finished:`,
            },
          },
          select: { id: true },
        });

        if (existingFinishedEvent) return;

        // A RESOLVED incident belongs to a successful outcome, not a failed
        // recovery. Do not attach an unrelated failed run to it.
        if (
          current.status === "RESOLVED" &&
          current.workflowRunId !== workflowRunId
        ) {
          return;
        }

        const activeStatuses = [
          "INVESTIGATING",
          "AWAITING_APPROVAL",
          "EXECUTING",
        ] as const;

        const shouldReopen = activeStatuses.includes(
          current.status as (typeof activeStatuses)[number],
        );

        const nextStatus = shouldReopen ? "OPEN" : current.status;

        // Compare-and-set on the observed status, run ID, and attempt token.
        // This avoids overwriting a concurrent status change or a newer retry.
        const updated = await tx.incident.updateMany({
          where: {
            id: incidentId,
            orgId,
            status: current.status,
            workflowRunId: current.workflowRunId,
            workflowAttemptToken: current.workflowAttemptToken,
          },
          data: {
            status: nextStatus,
            workflowRunId,
          },
        });

        if (updated.count !== 1) return;

        if (current.status !== nextStatus) {
          await tx.event.create({
            data: {
              orgId,
              incidentId,
              type: "incident_status_changed",
              payload: {
                from: current.status,
                to: nextStatus,
                reason: "workflow_failed",
              },
              actorId: null,
              externalId: statusChangedExternalId,
            },
          });
        }

        // If execution already moved the incident to RESOLVED but the
        // terminal bookkeeping failed, preserve the successful outcome.
        const reason =
          current.status === "RESOLVED" ? "resolved" : "failed";

        await tx.event.create({
          data: {
            orgId,
            incidentId,
            type: "workflow_finished",
            payload: {
              type: "workflow_finished",
              workflowRunId,
              reason,
              ts: Date.now(),
            },
            actorId: null,
            externalId: dedupeExternalId(
              incidentId,
              workflowEventDedupeKey(
                workflowRunId,
                "workflow",
                `finished:${reason}`,
              ),
            ),
          },
        });
      });
    },
  },
);