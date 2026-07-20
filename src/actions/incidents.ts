"use server";

import { z } from "zod";
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

const updateStatusSchema = z.object({
  incidentId: z.string().min(1),
  orgId: z.string().min(1),
  status: z.enum(["OPEN", "INVESTIGATING", "AWAITING_APPROVAL", "RESOLVED"]),
});

export async function updateIncidentStatus(input: unknown) {
  const parsed = updateStatusSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("Invalid status update payload.");
  }
  
  const { incidentId, orgId, status } = parsed.data;

  // Dynamic RBAC: RESOLVED is Commander-only; otherwise Engineers can update status.
  const allowedRoles = status === "RESOLVED" 
    ? (["COMMANDER"] as const) 
    : (["COMMANDER", "ENGINEER"] as const);
    
  const { userId } = await requireRole(orgId, [...allowedRoles]);

  const current = await db.incident.findFirst({ where: { id: incidentId, orgId } });
  if (!current) {
    throw new Error("Incident not found in this organization.");
  }

  await db.incident.update({
    where: { id: incidentId },
    data: { status },
  });

  await db.event.create({
    data: {
      orgId,
      incidentId,
      type: status === "RESOLVED" ? "incident_resolved" : "incident_status_changed",
      payload: { from: current.status, to: status },
      actorId: userId,
    },
  });
  updateTag(`incidents-${orgId}`);
}