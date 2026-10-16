"use server";

import { requireRole } from "@/lib/dal";
import { db } from "@/lib/db";
import { emitAgentEvent } from "@/lib/emit-agent-event";
import { Client } from "@upstash/workflow";
import { env } from "@/lib/env";
import { updateTag } from "next/cache";
import { approvalActionLimiter } from "@/lib/rate-limit";

const workflowClient = new Client({ token: env.QSTASH_TOKEN });

export async function respondToProposedAction(incidentId: string, orgId: string, approved: boolean) {
  const { userId } = await requireRole(orgId, ["COMMANDER"]);

  // The approval limiter is defense-in-depth, not the authorization boundary.
  // If Redis itself is unavailable, preserve the Commander's ability to approve
  // or reject the action rather than taking the human authorization path offline.
  // An explicit rate-limit denial still blocks the request.
  let approvalCheck: { success: boolean } | undefined;
  try {
    approvalCheck = await approvalActionLimiter.limit(userId);
  } catch (error) {
    console.error("[approval-rate-limit] Limiter unavailable; preserving human approval availability.", error);
  }

  if (approvalCheck && !approvalCheck.success) {
    throw new Error("Too many approval actions. Please wait a moment and try again.");
  }

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
  
  updateTag(`incidents-${orgId}`);
}