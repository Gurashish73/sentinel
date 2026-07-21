import "server-only";
import { db } from "@/lib/db";
import { z } from "zod";
import { Prisma } from "@prisma/client";

/**
 * Zod schema for incoming alert payloads.
 * Validates input from both external HTTP webhooks and internal Server Actions.
 */
export const alertSchema = z.object({
  title: z.string().min(3, "Title must be at least 3 characters").max(200),
  description: z.string().max(2000).optional(),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
  source: z.string().min(1, "Source identifier is required"),
  externalId: z.string().min(1, "External delivery ID is required"),
});

export type AlertInput = z.infer<typeof alertSchema>;

export type IngestResult =
  | { status: "created"; incidentId: string }
  | { status: "duplicate" };

/**
 * Atomically ingests an incoming security or infrastructure alert.
 * 
 * Architecture & Idempotency Guarantee:
 * Executes inside an interactive Prisma transaction ($transaction) to guarantee ACID compliance.
 * The `Event` table enforces a unique constraint on `@@unique([orgId, externalId])`.
 * If a duplicate webhook delivery lands, `tx.event.create` throws a Prisma P2002 error,
 * which automatically rolls back the created `Incident` row and safely returns `{ status: "duplicate" }`.
 * 
 * @param orgId The target tenant organization ID.
 * @param input Validated alert payload conforming to `alertSchema`.
 */
export async function ingestAlert(
  orgId: string,
  input: AlertInput
): Promise<IngestResult> {
  try {
    return await db.$transaction(async (tx) => {
      // 1. Create the parent Incident record within the transaction
      const incident = await tx.incident.create({
        data: {
          orgId,
          title: input.title,
          description: input.description,
          severity: input.severity,
        },
      });

      // 2. Append the immutable audit log event with externalId deduplication key
      await tx.event.create({
        data: {
          orgId,
          incidentId: incident.id,
          type: "alert_received",
          payload: {
            source: input.source,
            title: input.title,
            description: input.description ?? null,
          },
          externalId: input.externalId,
        },
      });

      return { status: "created", incidentId: incident.id };
    });
  } catch (err: unknown) {
    // Intercept unique constraint violation on @@unique([orgId, externalId])
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return { status: "duplicate" };
    }

    // Re-throw unhandled runtime exceptions (500 boundary)
    throw err;
  }
}