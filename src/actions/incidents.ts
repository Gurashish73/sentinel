"use server";

import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { IncidentStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/dal";
import { updateTag } from "next/cache";
import { ingestAlert, triggerIncidentWorkflow } from "@/lib/ingest-alert";

/**
 * INCIDENT SERVER ACTIONS
 * 
 * Handles all mutations for incidents. These actions are designed to be consumed
 * by React 19's `useActionState` hook. Every action strictly enforces RBAC via 
 * our Data Access Layer before parsing inputs with Zod.
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

  // 1. Authoritative Security Check
  // Verified fresh against the database, preventing stale JWT bypasses.
  const { userId } = await requireRole(orgId, ["COMMANDER", "ENGINEER"]);

  // 2. Input Sanitization
  const parsed = createIncidentSchema.safeParse({
    orgId,
    title: formData.get("title"),
    description: formData.get("description") || undefined,
    severity: formData.get("severity"),
  });

  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors };
  }

  // 3. Create the incident and audit event transactionally, then trigger the
  // same durable investigation workflow used by webhook-ingested alerts.
  const result = await ingestAlert(parsed.data.orgId, {
    title: parsed.data.title,
    description: parsed.data.description,
    severity: parsed.data.severity,
    source: "manual",
    externalId: `manual:${randomUUID()}`,
  }, {
    eventType: "incident_created",
    actorId: userId,
  });

  if (result.status !== "created") {
    return { message: "The incident could not be created. Please try again." };
  }

  // 4. Targeted Cache Invalidation
  // Instantly updates the UI for anyone viewing this organization's incident list.
  updateTag(`incidents-${orgId}`);
  
  return { message: "Incident created." };
}

const ALLOWED_STATUS_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  // The agent workflow, never a status-only button, starts investigation.
  OPEN: [],
  INVESTIGATING: [],
  AWAITING_APPROVAL: [],
  EXECUTING: [],
  RESOLVED: [],
  ESCALATION_REQUIRED: [],
};

const updateStatusSchema = z.object({
  incidentId: z.string().min(1),
  orgId: z.string().min(1),
  status: z.enum(["INVESTIGATING"]),
});

export async function updateIncidentStatus(input: unknown) {
  try {
    const parsed = updateStatusSchema.safeParse(input);
    if (!parsed.success) {
      return { error: "Invalid status update payload." };
    }

    const { incidentId, orgId, status } = parsed.data;
    const { userId } = await requireRole(orgId, ["COMMANDER", "ENGINEER"]);

    const result = await db.$transaction(async (tx) => {
      const current = await tx.incident.findFirst({
        where: { id: incidentId, orgId },
        select: { status: true },
      });
      if (!current) return { error: "Incident not found in this organization." } as const;

      if (!ALLOWED_STATUS_TRANSITIONS[current.status].includes(status)) {
        return { error: `Invalid incident status transition: ${current.status} → ${status}.` } as const;
      }

      const moved = await tx.incident.updateMany({
        where: { id: incidentId, orgId, status: current.status },
        data: { status },
      });
      if (moved.count !== 1) {
        return { error: "Incident status changed concurrently. Refresh and try again." } as const;
      }

      await tx.event.create({
        data: {
          orgId,
          incidentId,
          type: "incident_status_changed",
          payload: { from: current.status, to: status },
          actorId: userId,
        },
      });

      return { success: true } as const;
    });

    if ("error" in result) return result;
    updateTag(`incidents-${orgId}`);
    return result;
  } catch (error) {
    // Catch DAL throws (like requireRole rejections) and return cleanly to the UI
    if (error instanceof Error) return { error: error.message };
    return { error: "An unexpected error occurred." };
  }
}
const retryIncidentSchema = z.object({
  incidentId: z.string().min(1),
  orgId: z.string().min(1),
});

type RetryIncidentResult = { success: true } | { error: string };

const RETRYABLE_WORKFLOW_FINISH_REASONS = new Set([
  "rejected",
  "timed_out",
  "skipped",
  "no_proposal",
  "approval_mismatch",
  "blast_radius_exceeded",
]);

function isRetryableFinishPayload(payload: unknown, workflowRunId: string): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  const sameRun = value.workflowRunId === undefined || value.workflowRunId === workflowRunId;
  return sameRun && typeof value.reason === "string" && RETRYABLE_WORKFLOW_FINISH_REASONS.has(value.reason);
}

/**
 * Commander-controlled retry of a completed or failed investigation.
 * A fresh attempt token is reserved atomically before contacting QStash; stale
 * and duplicate workflow deliveries cannot claim the new attempt.
 */
export async function retryIncidentInvestigation(input: unknown): Promise<RetryIncidentResult> {
  try {
    const parsed = retryIncidentSchema.safeParse(input);
    if (!parsed.success) return { error: "Invalid retry request." };

    const { incidentId, orgId } = parsed.data;
    const { userId } = await requireRole(orgId, ["COMMANDER"]);
    const attemptToken = randomUUID();

    const reservation = await db.$transaction(async (tx) => {
      const current = await tx.incident.findFirst({
        where: { id: incidentId, orgId },
        select: {
          status: true,
          workflowRunId: true,
          workflowAttemptToken: true,
        },
      });

      if (!current) return { error: "Incident not found in this organization." } as const;
      if (current.status !== "OPEN" && current.status !== "ESCALATION_REQUIRED") {
        return { error: "This incident is not in a retryable state." } as const;
      }

      let eligible = false;
      if (current.workflowRunId) {
        const prefix = `sentinel-agent-event:${incidentId}:workflow:${current.workflowRunId}:workflow:finished:`;
        const terminalEvents = await tx.event.findMany({
          where: {
            orgId,
            incidentId,
            type: "workflow_finished",
            externalId: { startsWith: prefix },
          },
          orderBy: [{ streamSequence: "desc" }, { id: "desc" }],
          take: 10,
          select: { payload: true },
        });
        eligible = terminalEvents.some((event) => isRetryableFinishPayload(event.payload, current.workflowRunId!));
      } else if (current.status === "OPEN") {
        const triggerFailure = await tx.event.findFirst({
          where: { orgId, incidentId, type: "workflow_trigger_failed" },
          select: { id: true },
        });
        eligible = Boolean(triggerFailure);
      }

      if (!eligible) {
        return { error: "No completed or failed investigation is available to retry." } as const;
      }

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
        return { error: "Incident changed concurrently. Refresh and try again." } as const;
      }

      await tx.event.create({
        data: {
          orgId,
          incidentId,
          type: "incident_status_changed",
          payload: { from: current.status, to: "INVESTIGATING", reason: "operator_retry" },
          actorId: userId,
        },
      });

      return { attemptToken } as const;
    });

    if (typeof reservation.error === "string") return { error: reservation.error };

    try {
      await triggerIncidentWorkflow(incidentId, orgId, reservation.attemptToken);
    } catch (triggerError) {
      console.error("[retryIncidentInvestigation] QStash trigger failed:", triggerError);
      const reason = triggerError instanceof Error ? triggerError.message : "Unknown error";
      const rolledBack = await db.$transaction(async (tx) => {
        const moved = await tx.incident.updateMany({
          where: {
            id: incidentId,
            orgId,
            status: "INVESTIGATING",
            workflowRunId: null,
            workflowAttemptToken: reservation.attemptToken,
          },
          // Keep a non-null fencing token after rollback. A delayed legacy
          // delivery without an attemptToken must not match this incident.
          data: { status: "OPEN", workflowAttemptToken: randomUUID() },
        });
        if (moved.count !== 1) return false;

        await tx.event.create({
          data: {
            orgId,
            incidentId,
            type: "incident_status_changed",
            payload: { from: "INVESTIGATING", to: "OPEN", reason: "workflow_trigger_failed" },
            actorId: userId,
          },
        });
        await tx.event.create({
          data: {
            orgId,
            incidentId,
            type: "workflow_trigger_failed",
            payload: { reason, ts: Date.now() },
            actorId: null,
          },
        });
        return true;
      });

      if (!rolledBack) {
        // The workflow might have claimed the attempt even though the final trigger request threw.
        const active = await db.$transaction(async (tx) => tx.incident.findFirst({
          where: {
            id: incidentId,
            orgId,
            workflowAttemptToken: reservation.attemptToken,
            workflowRunId: { not: null },
          },
          select: { id: true },
        }));
        if (active) {
          // The workflow claimed this attempt despite the trigger request error.
          updateTag(`incidents-${orgId}`);
          return { success: true };
        }

        // A failed compare-and-set means another operation may have changed
        // the incident. Do not claim it is OPEN without confirming that state.
        updateTag(`incidents-${orgId}`);
        return {
          error: "The workflow trigger failed, but the incident changed concurrently. Refresh to check its current state.",
        };
      }

      updateTag(`incidents-${orgId}`);
      return { error: "The workflow trigger failed. The incident is open and can be retried." };
    }

    updateTag(`incidents-${orgId}`);
    return { success: true };
  } catch (error) {
    if (error instanceof Error) return { error: error.message };
    return { error: "Unable to retry this investigation." };
  }
}
