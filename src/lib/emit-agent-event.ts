import "server-only";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { revalidateTag } from "next/cache";
import type { AgentEvent } from "@/lib/event";

/**
 * Stable key for an event emitted by one logical workflow run.
 * A replay of the same durable step reuses its workflowRunId and key, while a
 * separately triggered workflow run receives a different namespace.
 */
export function workflowEventDedupeKey(
  workflowRunId: string,
  stage: string,
  eventName: string,
  discriminator?: string,
): string {
  const suffix = discriminator === undefined
    ? ""
    : `:${createHash("sha256").update(discriminator).digest("hex").slice(0, 16)}`;
  return `workflow:${workflowRunId}:${stage}:${eventName}${suffix}`;
}

/** Namespaced through Event.externalId, whose (orgId, externalId) pair is unique. */
export function dedupeExternalId(incidentId: string, dedupeKey: string): string {
  return `sentinel-agent-event:${incidentId}:${dedupeKey}`;
}

export type EmitOptions = { dedupeKey?: string };

function isExternalIdConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }

  const target = error.meta?.target;
  if (Array.isArray(target)) {
    return target.includes("orgId") && target.includes("externalId");
  }

  return typeof target === "string" && target.includes("externalId");
}

/**
 * Persist an agent/lifecycle event. When a dedupeKey is supplied, the database's
 * unique (orgId, externalId) constraint makes retries of the same logical event a
 * no-op. Returns true when inserted and false when the event already existed.
 */
export async function emitAgentEvent(
  orgId: string,
  incidentId: string,
  event: AgentEvent,
  options: EmitOptions = {},
): Promise<boolean> {
  const payload = JSON.parse(JSON.stringify(event)) as Prisma.InputJsonValue;

  try {
    await db.event.create({
      data: {
        orgId,
        incidentId,
        type: event.type,
        payload,
        actorId: "actorId" in event ? event.actorId : null,
        externalId: options.dedupeKey
          ? dedupeExternalId(incidentId, options.dedupeKey)
          : undefined,
      },
    });
  } catch (error) {
    // Only swallow a collision on the exact constraint used for event deduplication.
    // Other P2002 errors still indicate a different integrity problem and must surface.
    if (!options.dedupeKey || !isExternalIdConflict(error)) throw error;
    revalidateTag(`incidents-${orgId}`, { expire: 0 });
    return false;
  }

  revalidateTag(`incidents-${orgId}`, { expire: 0 });
  return true;
}