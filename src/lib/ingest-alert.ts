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
  source: z.string().min(1),
  externalId: z.string().min(1),
});

export type IngestResult =
  | { status: "created"; incidentId: string }
  | { status: "duplicate" };

const workflowClient = new Client({ token: env.QSTASH_TOKEN });

/**
 * Triggers the agent workflow and records the run ID.
 * Extracted to share logic between the primary ingestion path and the self-healing retry path.
 */
async function triggerWorkflow(incidentId: string, orgId: string): Promise<void> {
  const { workflowRunId } = await workflowClient.trigger({
    url: `${env.NEXT_PUBLIC_APP_URL}/api/workflow/agent`,
    body: { incidentId, orgId },
  });
  
  await db.incident.update({
    where: { id: incidentId },
    data: { workflowRunId, status: "INVESTIGATING" },
  });
}

/**
 * Writes an Incident + Event idempotently.
 * Enforces transaction safety and includes a self-healing mechanism for partial failures.
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
          select: { workflowRunId: true },
        });
        
        if (incident && !incident.workflowRunId) {
          await triggerWorkflow(existingEvent.incidentId, orgId);
        }
      }

      return { status: "duplicate" };
    }
    throw err;
  }

  // Deliberately outside the transaction: never hold open DB row locks for external network I/O.
  if (result.status === "created") {
    try {
      await triggerWorkflow(result.incidentId, orgId);
    } catch (triggerError) {
      console.error("[ingestAlert] QStash network blip during workflow trigger:", triggerError);
      // We gracefully catch this so the UI/Webhook provider still receives a 200 OK 
      // for the successful DB write, but we log an event so the team knows the workflow 
      // needs to be manually kicked off or retried.
      await db.event.create({
        data: {
          orgId,
          incidentId: result.incidentId,
          type: "thought", // Reusing the thought type for a system log
          payload: { text: "⚠️ System Warning: Failed to trigger agent workflow due to network error. Incident is stuck in OPEN state." },
        }
      });
    }
  }
  return result;
}

  