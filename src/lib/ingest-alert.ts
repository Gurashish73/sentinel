import "server-only";
import { db } from "@/lib/db";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { Client } from "@upstash/workflow";
import { env } from "@/lib/env";

export const alertSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(2000).optional(),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
  source: z.string().min(1), // "github" | "sentry" | "synthetic" | ...
  externalId: z.string().min(1),
});

export type IngestResult =
  | { status: "created"; incidentId: string }
  | { status: "duplicate" };

const workflowClient = new Client({ token: env.QSTASH_TOKEN });

/**
 * Writes an Incident + an `alert_received` Event, keyed for idempotency on
 * (orgId, externalId), then triggers Phase 3's agent workflow. Both writes
 * happen inside one transaction — if the Event insert hits the (orgId,
 * externalId) unique constraint, the Incident it was paired with rolls back
 * too, instead of leaving an orphaned Incident with no matching Event.
 */
export async function ingestAlert(
  orgId: string,
  input: z.infer<typeof alertSchema>,
): Promise<IngestResult> {
  let result: IngestResult;

  try {
    result = await db.$transaction(async (tx) => {
      const incident = await tx.incident.create({
        data: {
          orgId,
          title: input.title,
          description: input.description,
          severity: input.severity,
        },
      });

      await tx.event.create({
        data: {
          orgId,
          incidentId: incident.id,
          type: "alert_received",
          payload: { source: input.source, title: input.title },
          externalId: input.externalId,
        },
      });

      return { status: "created", incidentId: incident.id };
    });
  } catch (err) {
    // P2002 = unique constraint violation, i.e. this exact (orgId,
    // externalId) pair already landed. That's a successful no-op from the
    // caller's point of view, not an error — a retried webhook should get
    // a clean 200, not a 409 that makes the sender think something broke
    // and keep retrying.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { status: "duplicate" };
    }
    throw err;
  }

  // Deliberately outside the transaction: client.trigger() is a network
  // call to QStash, not a database statement. A transaction should only
  // ever hold open database work — mixing in an HTTP call means the
  // transaction's connection (and any row locks) stays open for however
  // long that network call takes, and if triggering fails partway through,
  // Prisma has no way to roll back an HTTP request the way it rolls back a
  // SQL statement. Sequential, not nested.
  if (result.status === "created") {
    const { workflowRunId } = await workflowClient.trigger({
      url: `${env.NEXT_PUBLIC_APP_URL}/api/workflow/agent`,
      body: { incidentId: result.incidentId, orgId },
    });
    await db.incident.update({
      where: { id: result.incidentId },
      data: { workflowRunId, status: "INVESTIGATING" },
    });
  }

  return result;
}