"use server";

import { z } from "zod";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/dal";
import { signOut } from "@/auth";

/**
 * ONBOARDING SERVER ACTIONS
 * 
 * Handles the critical path of provisioning a new workspace for a user.
 * It ensures strict validation of URL-safe slugs and safely handles 
 * the authorization state transition by forcing a session refresh.
 */

const createOrgSchema = z.object({
  name: z.string().min(2).max(100),
  slug: z
    .string()
    .min(2)
    .max(50)
    // Ensures the slug is perfectly URL-safe for potential future sub-domain routing
    .regex(/^[a-z0-9-]+$/, "Lowercase letters, numbers, and hyphens only."),
});

export type CreateOrgState = { 
  errors?: Record<string, string[]>; 
  message?: string;
};

export async function createOrgAndBecomeCommander(
  _prev: CreateOrgState,
  formData: FormData,
): Promise<CreateOrgState> {
  // 1. Base Security Check
  // The user doesn't have an org yet, so we only require a valid session.
  const session = await requireSession();

  // 2. Input Sanitization
  const parsed = createOrgSchema.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
  });
  
  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors };
  }

  // 3. Graceful Conflict Resolution
  // Prevent Prisma from throwing a hard 500 error on unique constraint violations.
  const existing = await db.organization.findUnique({ 
    where: { slug: parsed.data.slug } 
  });
  
  if (existing) {
    return { errors: { slug: ["That slug is already taken."] } };
  }

  // 4. Database Transaction (Provisioning)
  const org = await db.organization.create({
    data: { name: parsed.data.name, slug: parsed.data.slug },
  });

  await db.membership.create({
    data: { userId: session.user.id, orgId: org.id, role: "COMMANDER" },
  });

  // 5. State Synchronization (The JWT Refresh)
  // Force a real sign-out so the next OAuth login mints a fresh JWT.
  // This physically propagates the newly created activeOrgId/role into 
  // the Next.js Edge proxy and our DAL logic, preventing stale access issues.
  await signOut({ redirectTo: "/login" });
  return {};
}