import { serve } from "@upstash/workflow/nextjs";
import { db } from "@/lib/db";
import { runTriage } from "@/agents/triage";
import { runDiagnosis } from "@/agents/diagnosis";
import { proposeRemediation } from "@/agents/remediation";
import { emitAgentEvent, workflowEventDedupeKey } from "@/lib/emit-agent-event";
import { orgExecutionLimiter } from "@/lib/rate-limit";
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

  const incident = await context.run("load-incident", async () => {
    return db.incident.findUniqueOrThrow({ where: { id: incidentId } });
  });

  const triage = await context.run("triage", () => runTriage(incident, orgId, workflowRunId));
  if (!triage.shouldInvestigate) {
    await context.run("mark-skipped", () =>
      emitOnce({ type: "workflow_finished", reason: "skipped", ts: Date.now() }, "finished:skipped"),
    );
    return;
  }

  const diagnosis = await context.run("diagnosis", () => runDiagnosis(incident, orgId, workflowRunId));

  await context.run("propose-remediation", () =>
    proposeRemediation(incident, orgId, diagnosis, workflowRunId),
  );

  const { eventData, timeout } = await context.waitForEvent(
    "human-approval",
    `incident-${incidentId}-approval`,
    { timeout: "1d" },
  );

  if (timeout) {
    await context.run("mark-timed-out", async () => {
      await emitOnce({ type: "action_timed_out", ts: Date.now() }, "action-timed-out");
      await db.incident.update({ where: { id: incidentId }, data: { status: "OPEN" } });
      await emitOnce(
        { type: "workflow_finished", reason: "timed_out", ts: Date.now() },
        "finished:timed-out",
      );
    });
    return;
  }

  const approved = (eventData as { approved: boolean }).approved;

  if (!approved) {
    await context.run("record-rejection", async () => {
      // Keep the reasoning event idempotent as well as the terminal lifecycle event.
      await emitOnce(
        {
          type: "thought",
          text: "Remediation was rejected. Returning incident to OPEN state.",
          ts: Date.now(),
        },
        "rejection-thought",
      );
      await db.incident.update({ where: { id: incidentId }, data: { status: "OPEN" } });
      await emitOnce(
        { type: "workflow_finished", reason: "rejected", ts: Date.now() },
        "finished:rejected",
      );
    });
    return;
  }

  // BLAST-RADIUS CHECK: runs after human approval and before execution.
  // Only serializable fields are returned from the durable workflow step;
  // Upstash's `pending` analytics Promise is intentionally discarded.
  const executionCheck = await context.run(
    "check-blast-radius",
    async () => {
      const { success, limit, remaining, reset } = await orgExecutionLimiter.limit(orgId);
      return { success, limit, remaining, reset };
    },
  );

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

      await db.incident.update({
        where: { id: incidentId },
        data: { status: "ESCALATION_REQUIRED" },
      });

      await emitOnce(
        { type: "workflow_finished", reason: "blast_radius_exceeded", ts: Date.now() },
        "finished:blast-radius-exceeded",
      );
    });
    return;
  }

  await context.run("execute-action", async () => {
    // SIMULATED — see the note in src/agents/remediation.ts. Nothing
    // here touches real infrastructure.
    await emitOnce(
      {
        type: "action_executed",
        action: "simulated remediation",
        result: { note: "This is a demo action, not a real infrastructure change." },
        ts: Date.now(),
      },
      "action-executed",
    );
    await db.incident.update({ where: { id: incidentId }, data: { status: "RESOLVED" } });
    await emitOnce(
      { type: "workflow_finished", reason: "resolved", ts: Date.now() },
      "finished:resolved",
    );
  });
});