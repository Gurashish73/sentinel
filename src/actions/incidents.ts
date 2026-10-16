"use server";

import { z } from "zod";
import type { IncidentStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/dal";
import { updateTag } from "next/cache";

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

  // 3. Database Mutation & Audit Logging
  const incident = await db.incident.create({
    data: {
      orgId: parsed.data.orgId,
      title: parsed.data.title,
      description: parsed.data.description,
      severity: parsed.data.severity,
    },
  });

  // Write to the immutable event log for the timeline UI
  await db.event.create({
    data: {
      orgId: parsed.data.orgId,
      incidentId: incident.id,
      type: "incident_created",
      payload: { title: incident.title },
      actorId: userId,
    },
  });

  // 4. Targeted Cache Invalidation
  // Instantly updates the UI for anyone viewing this organization's incident list.
  updateTag(`incidents-${orgId}`);
  
  return { message: "Incident created." };
}

const ALLOWED_STATUS_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  OPEN: ["INVESTIGATING"],
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