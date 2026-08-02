import { serve } from "@upstash/workflow/nextjs";
import { db } from "@/lib/db";
import { runTriage } from "@/agents/triage";
import { runDiagnosis } from "@/agents/diagnosis";
import { proposeRemediation } from "@/agents/remediation";
import { emitAgentEvent } from "@/lib/emit-agent-event";

type Payload = { incidentId: string; orgId: string };

export const { POST } = serve<Payload>(async (context) => {
  const { incidentId, orgId } = context.requestPayload;

  const incident = await context.run("load-incident", async () => {
    return db.incident.findUniqueOrThrow({ where: { id: incidentId } });
  });

  const triage = await context.run("triage", () => runTriage(incident, orgId));
  if (!triage.shouldInvestigate) {
    await context.run("mark-skipped", () =>
      emitAgentEvent(orgId, incidentId, { type: "workflow_finished", reason: "skipped", ts: Date.now() }),
    );
    return;
  }

  const diagnosis = await context.run("diagnosis", () => runDiagnosis(incident, orgId));

  await context.run("propose-remediation", () => proposeRemediation(incident, orgId, diagnosis));

  const { eventData, timeout } = await context.waitForEvent(
    "human-approval",
    `incident-${incidentId}-approval`,
    { timeout: "1d" },
  );

  if (timeout) {
    await context.run("mark-timed-out", async () => {
      await emitAgentEvent(orgId, incidentId, { type: "action_timed_out", ts: Date.now() });
      await db.incident.update({ where: { id: incidentId }, data: { status: "OPEN" } });
      await emitAgentEvent(orgId, incidentId, { type: "workflow_finished", reason: "timed_out", ts: Date.now() });
    });
    return;
  }

  const approved = (eventData as { approved: boolean }).approved;

  await context.run(approved ? "execute-action" : "record-rejection", async () => {
    if (approved) {
      // SIMULATED — see the note in src/agents/remediation.ts. Nothing
      // here touches real infrastructure.
      await emitAgentEvent(orgId, incidentId, {
        type: "action_executed",
        action: "simulated remediation",
        result: { note: "This is a demo action, not a real infrastructure change." },
        ts: Date.now(),
      });
      await db.incident.update({ where: { id: incidentId }, data: { status: "RESOLVED" } });
      await emitAgentEvent(orgId, incidentId, { type: "workflow_finished", reason: "resolved", ts: Date.now() });
    } else {
      // Added this event to force a cache invalidation AFTER the DB updates,
      // permanently fixing the UI race condition on rejection.
      await emitAgentEvent(orgId, incidentId, {
        type: "thought",
        text: "Remediation was rejected. Returning incident to OPEN state.",
        ts: Date.now()
      });
      await db.incident.update({ where: { id: incidentId }, data: { status: "OPEN" } });
      await emitAgentEvent(orgId, incidentId, { type: "workflow_finished", reason: "rejected", ts: Date.now() });
    }
  });
});