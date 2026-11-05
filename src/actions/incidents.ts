"use server";

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/dal";
import { updateTag } from "next/cache";
import { ingestAlert, triggerIncidentWorkflow } from "@/lib/ingest-alert";
import { isRetryableWorkflowFinishEvent } from "@/lib/retry-eligibility";

/**
 * INCIDENT SERVER ACTIONS
 *
 * Handles all mutations for incidents. Every action enforces authorization
 * through the database-backed Data Access Layer.
 */

const createIncidentSchema = z.object({
  orgId: z.string().min(1),
  title: z.string().min(3, "Title needs at least 3 characters").max(200),
  description: z.string().max(2000).optional(),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
});

export type CreateIncidentState = {
  errors?: Record<string, string[]>;
  message?: string;
};

export async function createIncident(
  _prevState: CreateIncidentState,
  formData: FormData,
): Promise<CreateIncidentState> {
  const orgId = formData.get("orgId");
  if (typeof orgId !== "string") {
    return { message: "Missing organization." };
  }

  // Authoritative database-backed security check.
  const { userId } = await requireRole(orgId, [
    "COMMANDER",
    "ENGINEER",
  ]);

  // Validate and sanitize input.
  const parsed = createIncidentSchema.safeParse({
    orgId,
    title: formData.get("title"),
    description: formData.get("description") || undefined,
    severity: formData.get("severity"),
  });

  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors };
  }

  // Create the incident and trigger the durable investigation workflow.
  const result = await ingestAlert(
    parsed.data.orgId,
    {
      title: parsed.data.title,
      description: parsed.data.description,
      severity: parsed.data.severity,
      source: "manual",
      externalId: `manual:${randomUUID()}`,
    },
    {
      eventType: "incident_created",
      actorId: userId,
    },
  );

  if (result.status !== "created") {
    return {
      message: "The incident could not be created. Please try again.",
    };
  }

  updateTag(`incidents-${orgId}`);

  return { message: "Incident created." };
}

const retryIncidentSchema = z.object({
  incidentId: z.string().min(1),
  orgId: z.string().min(1),
});

type RetryIncidentResult =
  | { success: true }
  | { error: string };

/**
 * Commander-controlled retry of a completed or failed investigation.
 *
 * A fresh attempt token is reserved atomically before contacting QStash.
 * Stale and duplicate workflow deliveries cannot claim a newer attempt.
 */
export async function retryIncidentInvestigation(
  input: unknown,
): Promise<RetryIncidentResult> {
  try {
    const parsed = retryIncidentSchema.safeParse(input);
    if (!parsed.success) {
      return { error: "Invalid retry request." };
    }

    const { incidentId, orgId } = parsed.data;
    const { userId } = await requireRole(orgId, ["COMMANDER"]);
    const attemptToken = randomUUID();

    // Atomically reserve a fresh investigation attempt.
    const reservation = await db.$transaction(async (tx) => {
      const current = await tx.incident.findFirst({
        where: { id: incidentId, orgId },
        select: {
          status: true,
          workflowRunId: true,
          workflowAttemptToken: true,
        },
      });

      if (!current) {
        return {
          error: "Incident not found in this organization.",
        } as const;
      }

      if (
        current.status !== "OPEN" &&
        current.status !== "ESCALATION_REQUIRED"
      ) {
        return {
          error: "This incident is not in a retryable state.",
        } as const;
      }

      let eligible = false;
      const workflowRunId = current.workflowRunId;

      if (workflowRunId) {
        const prefix =
          `sentinel-agent-event:${incidentId}:workflow:${workflowRunId}:workflow:finished:`;

        const terminalEvents = await tx.event.findMany({
          where: {
            orgId,
            incidentId,
            type: "workflow_finished",
            externalId: { startsWith: prefix },
          },
          orderBy: [
            { streamSequence: "desc" },
            { id: "desc" },
          ],
          take: 10,
          select: {
            type: true,
            externalId: true,
            payload: true,
          },
        });

        // Use the shared eligibility rule instead of maintaining
        // a separate retryable-reason list in this server action.
        eligible = terminalEvents.some((event) =>
          isRetryableWorkflowFinishEvent(
            event,
            incidentId,
            workflowRunId,
          ),
        );
      } else if (current.status === "OPEN") {
        // An OPEN incident without a workflow run may have been committed
        // before the process crashed while triggering its first workflow.
        // A trigger-failure event is telemetry, not a recovery prerequisite.
        eligible = true;
      }

      if (!eligible) {
        return {
          error: "No completed or failed investigation is available to retry.",
        } as const;
      }

      // Compare-and-set protects against concurrent reservations.
      const moved = await tx.incident.updateMany({
        where: {
          id: incidentId,
          orgId,
          status: current.status,
          workflowRunId: current.workflowRunId,
          workflowAttemptToken: current.workflowAttemptToken,
        },
        data: {
          status: "INVESTIGATING",
          workflowRunId: null,
          workflowAttemptToken: attemptToken,
        },
      });

      if (moved.count !== 1) {
        return {
          error: "Incident changed concurrently. Refresh and try again.",
        } as const;
      }

      await tx.event.create({
        data: {
          orgId,
          incidentId,
          type: "incident_status_changed",
          payload: {
            from: current.status,
            to: "INVESTIGATING",
            reason: "operator_retry",
          },
          actorId: userId,
        },
      });

      return { attemptToken } as const;
    });

    if (typeof reservation.error === "string") {
      return { error: reservation.error };
    }

    if (typeof reservation.attemptToken !== "string") {
      return {
        error: "Unable to reserve the investigation attempt. Please try again.",
      };
    }

    // Trigger the newly reserved workflow attempt.
    try {
      await triggerIncidentWorkflow(
        incidentId,
        orgId,
        reservation.attemptToken,
      );
    } catch (triggerError) {
      console.error(
        "[retryIncidentInvestigation] QStash trigger failed:",
        triggerError,
      );

      // Roll back only if this attempt still owns the reservation.
      const rolledBack = await db.$transaction(async (tx) => {
        const moved = await tx.incident.updateMany({
          where: {
            id: incidentId,
            orgId,
            status: "INVESTIGATING",
            workflowRunId: null,
            workflowAttemptToken: reservation.attemptToken,
          },

          // Never reset the token to null.
          // Delayed legacy deliveries must not match this reservation.
          data: {
            status: "OPEN",
            workflowAttemptToken: randomUUID(),
          },
        });

        if (moved.count !== 1) {
          return false;
        }

        await tx.event.create({
          data: {
            orgId,
            incidentId,
            type: "incident_status_changed",
            payload: {
              from: "INVESTIGATING",
              to: "OPEN",
              reason: "workflow_trigger_failed",
            },
            actorId: userId,
          },
        });

        await tx.event.create({
          data: {
            orgId,
            incidentId,
            type: "workflow_trigger_failed",
            // Persist only a safe reason code. Detailed provider errors stay
            // in server logs and must not be exposed through the event stream.
            payload: {
              reason: "workflow_trigger_failed",
              ts: Date.now(),
            },
            actorId: null,
          },
        });
        return true;
      });

      // STEP 4: The workflow may have claimed this attempt even though
      // the final QStash trigger request returned an error.
      if (!rolledBack) {
        const active = await db.incident.findFirst({
          where: {
            id: incidentId,
            orgId,

            // A run ID alone does not prove that this attempt is active.
            status: {
              in: [
                "INVESTIGATING",
                "AWAITING_APPROVAL",
                "EXECUTING",
              ],
            },
            workflowAttemptToken: reservation.attemptToken,
            workflowRunId: { not: null },
          },
          select: { id: true },
        });
        if (active) {
          updateTag(`incidents-${orgId}`);
          return { success: true };
        }

        updateTag(`incidents-${orgId}`);
        return {
          error:
            "The workflow trigger failed, but the incident changed concurrently. Refresh to check its current state.",
        };
      }

      updateTag(`incidents-${orgId}`);
      return {
        error:
          "The workflow trigger failed. The incident is open and can be retried.",
      };
    }

    // STEP 5: Successful workflow trigger.
    updateTag(`incidents-${orgId}`);

    return { success: true };
  } catch (error) {
    // Keep implementation details in server logs.
    // Never expose database, provider, or infrastructure errors to the client.
    console.error(
      "[retryIncidentInvestigation] Unexpected failure:",
      error,
    );
    return {
      error: "Unable to retry this investigation. Please try again.",
    };
  }
}
