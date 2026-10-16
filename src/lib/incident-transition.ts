import "server-only";

import { Prisma } from "@prisma/client";
import { revalidateTag } from "next/cache";
import { db } from "@/lib/db";
import { dedupeExternalId } from "@/lib/emit-agent-event";
import type { AgentEvent } from "@/lib/event";

type LifecycleEvent = Extract<
  AgentEvent,
  { type: "action_timed_out" | "thought" | "blast_radius_exceeded" }
>;

export type IncidentTransitionResult = "transitioned" | "superseded";

/**
 * Compare-and-set a workflow-owned incident transition and persist its lifecycle
 * event atomically. Replays of the same durable step recognize the event key and
 * return the prior outcome only while the incident still has the target status.
 */
export async function transitionIncidentWithEvent(input: {
  incidentId: string;
  orgId: string;
  workflowRunId: string;
  fromStatus: "AWAITING_APPROVAL";
  toStatus: "OPEN" | "ESCALATION_REQUIRED";
  event: LifecycleEvent;
  dedupeKey: string;
}): Promise<IncidentTransitionResult> {
  const { incidentId, orgId, workflowRunId, fromStatus, toStatus, event, dedupeKey } = input;
  const externalId = dedupeExternalId(incidentId, dedupeKey);
  const payload = JSON.parse(JSON.stringify(event)) as Prisma.InputJsonValue;

  const result = await db.$transaction(async (tx) => {
    const current = await tx.incident.findFirst({
      where: { id: incidentId, orgId, workflowRunId },
      select: { status: true },
    });
    const existingEvent = await tx.event.findUnique({
      where: { orgId_externalId: { orgId, externalId } },
      select: { type: true, payload: true },
    });

    if (existingEvent) {
      const existingPayload = existingEvent.payload;
      const eventMatches =
        existingEvent.type === event.type &&
        !!existingPayload &&
        typeof existingPayload === "object" &&
        !Array.isArray(existingPayload) &&
        (existingPayload as Record<string, unknown>).type === event.type;
      return eventMatches && current?.status === toStatus ? "transitioned" : "superseded";
    }

    if (!current || current.status !== fromStatus) return "superseded";

    const moved = await tx.incident.updateMany({
      where: { id: incidentId, orgId, workflowRunId, status: fromStatus },
      data: { status: toStatus },
    });

    if (moved.count !== 1) {
      // Another delivery may have committed the same transition while this one
      // waited on the row lock. Re-read before deciding whether this is a replay.
      const refreshed = await tx.incident.findFirst({
        where: { id: incidentId, orgId, workflowRunId },
        select: { status: true },
      });
      const racedEvent = await tx.event.findUnique({
        where: { orgId_externalId: { orgId, externalId } },
        select: { type: true, payload: true },
      });
      const racedPayload = racedEvent?.payload;
      const eventMatches =
        racedEvent?.type === event.type &&
        !!racedPayload &&
        typeof racedPayload === "object" &&
        !Array.isArray(racedPayload) &&
        (racedPayload as Record<string, unknown>).type === event.type;
      return eventMatches && refreshed?.status === toStatus ? "transitioned" : "superseded";
    }

    await tx.event.create({
      data: {
        orgId,
        incidentId,
        type: event.type,
        payload,
        actorId:
          "actorId" in event && typeof event.actorId === "string"
            ? event.actorId
            : null,
        externalId,
      },
    });

    return "transitioned";
  });

  if (result === "transitioned") revalidateTag(`incidents-${orgId}`, { expire: 0 });
  return result;
}
