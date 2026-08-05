import "server-only";
import { db } from "@/lib/db";
import { revalidateTag } from "next/cache";
import type { Prisma } from "@prisma/client";
import type { AgentEvent } from "@/lib/event";

export async function emitAgentEvent(orgId: string, incidentId: string, event: AgentEvent) {
  // Round-trip through JSON to guarantee the payload is strictly JSON-safe. 
  // Using `as any` silences the type-checker but risks passing Dates, undefined, 
  // or class instances into Prisma's internal serializer, which causes unexpected 
  // runtime behavior. This proves the payload is safe before persistence.
  const payload = JSON.parse(JSON.stringify(event)) as Prisma.InputJsonValue;

  await db.event.create({
    data: {
      orgId,
      incidentId,
      type: event.type,
      payload,
      actorId: null, // Null indicates an autonomous agent action, not a human user.
    },
  });

  revalidateTag(`incidents-${orgId}`, { expire: 0 });
}