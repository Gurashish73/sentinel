import "server-only";
import { db } from "@/lib/db";
import { revalidateTag } from "next/cache";
import type { AgentEvent } from "@/lib/event";

export async function emitAgentEvent(orgId: string, incidentId: string, event: AgentEvent) {
  await db.event.create({
    data: {
      orgId,
      incidentId,
      type: event.type,
      payload: event as any,
      actorId: null, // the actor is an agent, not a human — see schema.prisma's comment on Event.actorId
    },
  });

  revalidateTag(`incidents-${orgId}`, { expire: 0 });
}