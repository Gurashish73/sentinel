import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { Client } from "@upstash/workflow";
import { env } from "@/lib/env";
import { emitAgentEvent } from "@/lib/emit-agent-event";

export const alertSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(2000).optional(),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
  source: z.string().min(1),
  externalId: z.string().min(1),
});

export type IngestResult =
  | { status: "created"; incidentId: string }
  | { status: "duplicate" };

export type IngestAlertOptions = {
  eventType?: "alert_received" | "incident_created";
  actorId?: string;
};

const workflowClient = new Client({ token: env.QSTASH_TOKEN });

const TRIGGER_MAX_ATTEMPTS = 3;
const TRIGGER_RETRY_BASE_MS = 500;

/**
 * Triggers the agent workflow and records the run ID.
 * Extracted to share logic between the primary ingestion path and the self-healing retry path.
 *
 * Retries a few times with linear backoff before giving up. This matters more than it used to:
 * since ingestAlert() no longer 500s the caller on a trigger failure, a webhook provider has no
 * reason to redeliver and land on the self-healing branch below. These in-process retries are now
 * the primary defense against a transient QStash blip, not a backup to the sender's own retry.
 */
async function triggerWorkflow(incidentId: string, orgId: string, attemptToken: string): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= TRIGGER_MAX_ATTEMPTS; attempt++) {
    try {
      const { workflowRunId } = await workflowClient.trigger({
        url: `${env.NEXT_PUBLIC_APP_URL}/api/workflow/agent`,
        body: { incidentId, orgId, attemptToken },
      });

      // Do not set status here: the workflow may already have advanced by the time
      // this trigger call returns. The workflow's first durable step claims OPEN and
      // records its run ID atomically; this fallback only records an as-yet-unclaimed run.
      await db.incident.updateMany({
        where: { id: incidentId, orgId, workflowRunId: null, workflowAttemptToken: attemptToken },
        data: { workflowRunId },
      });
      return;
    } catch (err) {
      lastError = err;
      if (attempt < TRIGGER_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * TRIGGER_RETRY_BASE_MS));
      }
    }
  }

  throw lastError;
}

/** Trigger an already-persisted, token-reserved investigation attempt. */
export async function triggerIncidentWorkflow(incidentId: string, orgId: string, attemptToken: string): Promise<void> {
  await triggerWorkflow(incidentId, orgId, attemptToken);
}

/**
 * Writes an Incident + Event idempotently.
 * Enforces transaction safety and includes a self-healing mechanism for partial failures.
 */
export async function ingestAlert(
  orgId: string,
  input: z.infer<typeof alertSchema>,
  options: IngestAlertOptions = {},
): Promise<IngestResult> {
  let result: IngestResult;
  const attemptToken = randomUUID();

  try {
    result = await db.$transaction(async (tx) => {
      const incident = await tx.incident.create({
        data: {
          orgId,
          title: input.title,
          description: input.description,
          severity: input.severity,
          workflowAttemptToken: attemptToken,
        },
      });

      await tx.event.create({
        data: {
          orgId,
          incidentId: incident.id,
          type: options.eventType ?? "alert_received",
          payload: options.eventType === "incident_created"
            ? { title: input.title }
            : { source: input.source, title: input.title },
          ...(options.actorId ? { actorId: options.actorId } : {}),
          externalId: input.externalId,
        },
      });

      return { status: "created", incidentId: incident.id };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Self-healing path: If the DB transaction committed previously but the QStash 
      // network call failed, the incident exists without an active workflow run. 
      // We use this webhook retry to recover the state and trigger the workflow.
      const existingEvent = await db.event.findUnique({
        where: { orgId_externalId: { orgId, externalId: input.externalId } },
        select: { incidentId: true },
      });

      if (existingEvent?.incidentId) {
        const incident = await db.incident.findUnique({
          where: { id: existingEvent.incidentId },
          select: { workflowRunId: true, workflowAttemptToken: true },
        });
        
        if (incident && !incident.workflowRunId) {
          let recoveryToken = incident.workflowAttemptToken;
          if (!recoveryToken) {
            recoveryToken = attemptToken;
            const reserved = await db.incident.updateMany({
              where: {
                id: existingEvent.incidentId,
                orgId,
                workflowRunId: null,
                workflowAttemptToken: null,
              },
              data: { workflowAttemptToken: recoveryToken },
            });
            if (reserved.count === 1) {
              await triggerWorkflow(existingEvent.incidentId, orgId, recoveryToken);
            }
          } else {
            await triggerWorkflow(existingEvent.incidentId, orgId, recoveryToken);
          }
        }
      }

      return { status: "duplicate" };
    }
    throw err;
  }

  // Deliberately outside the transaction: never hold open DB row locks for external network I/O.
  if (result.status === "created") {
    try {
      await triggerWorkflow(result.incidentId, orgId, attemptToken);
    } catch (triggerError) {
      console.error("[ingestAlert] QStash trigger failed after retries:", triggerError);
      // We gracefully catch this so the UI/Webhook provider still receives a 200 OK 
      // for the successful DB write, but we log an event so the team knows the workflow 
      // needs to be manually kicked off or retried.
      await emitAgentEvent(orgId, result.incidentId, {
        type: "workflow_trigger_failed",
        reason: triggerError instanceof Error ? triggerError.message : "Unknown error",
        ts: Date.now(),
      });
    }
  }
  return result;
}