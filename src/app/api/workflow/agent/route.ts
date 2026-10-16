import { serve } from "@upstash/workflow/nextjs";
import { db } from "@/lib/db";
import { runTriage } from "@/agents/triage";
import { runDiagnosis } from "@/agents/diagnosis";
import { proposeRemediation } from "@/agents/remediation";
import { emitAgentEvent, workflowEventDedupeKey } from "@/lib/emit-agent-event";
import { orgExecutionLimiter } from "@/lib/rate-limit";
import { approvalEventId } from "@/lib/proposal";
import { claimApprovedExecution, completeApprovedExecution } from "@/lib/execution-lifecycle";
import type { AgentEvent } from "@/lib/event";

type Payload = { incidentId: string; orgId: string };

export const { POST } = serve<Payload>(async (context) => {
  const { incidentId, orgId } = context.requestPayload;
  // Stable across retries of this durable workflow; a new workflow run gets a new namespace.
  const workflowRunId = context.workflowRunId;
  const emitOnce = (event: AgentEvent, name: string) =>
    emitAgentEvent(orgId, incidentId, event, {
      dedupeKey: workflowEventDedupeKey(workflowRunId, "workflow", name),
    });
  const finish = (reason: Extract<AgentEvent, { type: "workflow_finished" }> ["reason"]) =>
    emitOnce({ type: "workflow_finished", reason, ts: Date.now() }, `finished:${reason}`);

  // Claim workflow ownership before the agent pipeline runs. This also closes the
  // trigger race: either the trigger or this step may persist workflowRunId first.
  const startup = await context.run("mark-investigating", async () => {
    const claimed = await db.incident.updateMany({
      where: {
        id: incidentId,
        orgId,
        status: { in: ["OPEN", "INVESTIGATING"] },
        OR: [{ workflowRunId: null }, { workflowRunId }],
      },
      data: { status: "INVESTIGATING", workflowRunId },
    });
    if (claimed.count === 1) return "started" as const;

    const current = await db.incident.findFirst({
      where: { id: incidentId, orgId },
      select: { status: true, workflowRunId: true },
    });
    if (!current || current.workflowRunId !== workflowRunId) return "superseded" as const;
    if (current.status === "INVESTIGATING" || current.status === "AWAITING_APPROVAL") return "started" as const;
    return "completed" as const;
  });

  if (startup === "superseded") {
    await context.run("finish-superseded-start", () => finish("superseded"));
    return;
  }
  if (startup === "completed") return;

  const incident = await context.run("load-incident", async () => {
    const current = await db.incident.findFirst({
      where: { id: incidentId, orgId, workflowRunId },
    });
    if (!current) throw new Error("Incident is no longer owned by this workflow.");
    return current;
  });

  const triage = await context.run("triage", () => runTriage(incident, orgId, workflowRunId));
  if (!triage.shouldInvestigate) {
    await context.run("mark-skipped", async () => {
      await db.incident.updateMany({
        where: { id: incidentId, orgId, workflowRunId, status: "INVESTIGATING" },
        data: { status: "OPEN" },
      });
      await finish("skipped");
    });
    return;
  }

  const diagnosis = await context.run("diagnosis", () => runDiagnosis(incident, orgId, workflowRunId));
  const proposal = await context.run("propose-remediation", () =>
    proposeRemediation(incident, orgId, diagnosis, workflowRunId),
  );

  if (!proposal) {
    await context.run("no-proposal", async () => {
      await db.incident.updateMany({
        where: { id: incidentId, orgId, workflowRunId, status: "INVESTIGATING" },
        data: { status: "OPEN" },
      });
      await finish("no_proposal");
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
      await emitOnce({ type: "action_timed_out", ts: Date.now() }, "action-timed-out");
      const moved = await db.incident.updateMany({
        where: { id: incidentId, orgId, workflowRunId, status: "AWAITING_APPROVAL" },
        data: { status: "OPEN" },
      });
      await finish(moved.count === 1 ? "timed_out" : "superseded");
    });
    return;
  }

  const decision = (eventData ?? {}) as { approved?: unknown; proposalId?: unknown };
  if (typeof decision.approved !== "boolean" || decision.proposalId !== proposal.proposalId) {
    await context.run("reject-mismatched-approval", async () => {
      await emitOnce(
        { type: "thought", text: "Approval did not match the current remediation proposal; no action was executed.", ts: Date.now() },
        "approval-mismatch",
      );
      await db.incident.updateMany({
        where: { id: incidentId, orgId, workflowRunId, status: "AWAITING_APPROVAL" },
        data: { status: "OPEN" },
      });
      await finish("approval_mismatch");
    });
    return;
  }

  if (!decision.approved) {
    await context.run("record-rejection", async () => {
      await emitOnce(
        { type: "thought", text: "Remediation was rejected. Returning incident to OPEN state.", ts: Date.now() },
        "rejection-thought",
      );
      const moved = await db.incident.updateMany({
        where: { id: incidentId, orgId, workflowRunId, status: "AWAITING_APPROVAL" },
        data: { status: "OPEN" },
      });
      await finish(moved.count === 1 ? "rejected" : "superseded");
    });
    return;
  }

  // BLAST-RADIUS CHECK: runs after proposal-bound human approval and before execution.
  // Only serializable fields are returned from the durable step; the background
  // analytics `pending` Promise is intentionally discarded.
  const executionCheck = await context.run("check-blast-radius", async () => {
    const { success, limit, remaining, reset } = await orgExecutionLimiter.limit(orgId);
    return { success, limit, remaining, reset };
  });

  if (!executionCheck.success) {
    await context.run("block-on-blast-radius", async () => {
      await emitOnce(
        {
          type: "blast_radius_exceeded",
          text: "Approved action blocked: organization execution limit reached. Manual operator review required.",
          ts: Date.now(),
        },
        "blast-radius-exceeded",
      );
      await db.incident.updateMany({
        where: { id: incidentId, orgId, workflowRunId, status: "AWAITING_APPROVAL" },
        data: { status: "ESCALATION_REQUIRED" },
      });
      await finish("blast_radius_exceeded");
    });
    return;
  }

  // Atomically transition AWAITING_APPROVAL -> EXECUTING and persist a
  // proposal-bound claim event. Timeout/manual state changes that win the race
  // make this claim fail, so no action can be recorded after losing ownership.
  const executionClaim = await context.run("claim-execution", () =>
    claimApprovedExecution({ incidentId, orgId, proposal }),
  );

  if (executionClaim === "superseded") {
    await context.run("finish-superseded-execution", () => finish("superseded"));
    return;
  }

  if (executionClaim === "already_executed") {
    await context.run("finish-recovered-execution", () => finish("resolved"));
    return;
  }

  // The simulated effect (the action_executed audit record) and RESOLVED status
  // are committed in one database transaction. Replays recognize the same
  // proposal-specific event rather than recording execution twice.
  await context.run("execute-action", async () => {
    const outcome = await completeApprovedExecution({ incidentId, orgId, proposal });
    await finish(outcome === "completed" ? "resolved" : "superseded");
  });
});
