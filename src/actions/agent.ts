"use server";

import { requireRole } from "@/lib/dal";
import { db } from "@/lib/db";
import { emitAgentEvent } from "@/lib/emit-agent-event";
import { Client } from "@upstash/workflow";
import { env } from "@/lib/env";
import { revalidateTag } from "next/cache";

const workflowClient = new Client({ token: env.QSTASH_TOKEN });

export async function respondToProposedAction(incidentId: string, orgId: string, approved: boolean) {
  const { userId } = await requireRole(orgId, ["COMMANDER"]);

  const incident = await db.incident.findFirst({ where: { id: incidentId, orgId } });
  
  if (!incident?.workflowRunId) {
    throw new Error("No pending workflow found for this incident.");
  }

  // Prevent double-voting from a stale UI
  if (incident.status !== "AWAITING_APPROVAL") {
    throw new Error("This incident is no longer awaiting approval.");
  }

  await emitAgentEvent(orgId, incidentId, {
    type: approved ? "action_approved" : "action_rejected",
    actorId: userId,
    ts: Date.now(),
  });

  await workflowClient.notify({
    eventId: `incident-${incidentId}-approval`,
    eventData: { approved },
    workflowRunId: incident.workflowRunId,
  });

  // Next.js 16 requires the second cache profile argument. 
  // { expire: 0 } forces an immediate, synchronous cache purge.
  revalidateTag(`incidents-${orgId}`, { expire: 0 });
}