"use server";

import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/dal";
import { encryptSecret } from "@/lib/crypto";
import { revalidatePath } from "next/cache";

/**
 * ORGANIZATION SERVER ACTIONS
 * 
 * Handles organization-level configurations. Because these settings include 
 * sensitive credentials (like Webhook secrets for Phase 2), these actions 
 * are strictly restricted to the COMMANDER role and enforce encryption at rest.
 */

const orgSettingsSchema = z.object({
  orgId: z.string().min(1),
  name: z.string().min(2).max(100),
  // Handles both missing keys and explicitly empty strings from form inputs
  webhookSecret: z.string().min(16).optional().or(z.literal("")),
});

export type OrgSettingsState = { 
  errors?: Record<string, string[]>; 
  message?: string;
};

export async function updateOrgSettings(
  _prev: OrgSettingsState,
  formData: FormData,
): Promise<OrgSettingsState> {
  const orgId = formData.get("orgId");
  if (typeof orgId !== "string") {
    return { message: "Missing organization." };
  }

  // 1. Authoritative Security Check
  // Only Commanders can rotate secrets or change the org name.
  await requireRole(orgId, ["COMMANDER"]);

  // 2. Input Sanitization
  const parsed = orgSettingsSchema.safeParse({
    orgId,
    name: formData.get("name"),
    webhookSecret: formData.get("webhookSecret") || undefined,
  });
  
  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors };
  }

  // 3. Database Mutation & Encryption
  await db.organization.update({
    where: { id: orgId },
    data: {
      name: parsed.data.name,
      // Only touch the webhookSecret if a new one was actually submitted.
      // An empty field means "leave the current encrypted one alone."
      ...(parsed.data.webhookSecret
        ? { webhookSecret: encryptSecret(parsed.data.webhookSecret) }
        : {}),
    },
  });

  // 4. Invalidate the settings page cache to show the new name
  revalidatePath("/commander/settings");
  
  return { message: "Settings updated." };
}