import "server-only";
import { cache } from "react";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import type { Role, Membership } from "@prisma/client";

/**
 * DATA ACCESS LAYER (DAL) & AUTHORIZATION GATEWAY
 *
 * This file acts as the single source of truth for backend security.
 * We do NOT trust the browser's JWT session cookie for state mutations,
 * as JWTs can be stale (e.g., a user is demoted in the DB, but their
 * cookie still says "COMMANDER" for 30 days).
 *
 * Every Server Action and secure layout must route through these checks.
 */

/**
 * 1. Base Identity Check
 * The cheapest possible check: is anyone signed in at all?
 * Use this ONLY for pages that need a session but don't touch org data.
 */
export async function requireSession() {
  const session = await auth();

  if (!session?.user) redirect("/login");

  return session;
}

/**
 * 2. Tenant Routing Check
 * Uses the session's active organization for routing and confirms current
 * membership in the database.
 *
 * React cache deduplicates this call within a Server Component request,
 * avoiding repeated membership lookups from layouts and child pages.
 * This is request-scoped memoization, not a persistent cross-request cache.
 */
export const requireActiveOrg = cache(async function requireActiveOrg() {
  const session = await requireSession();
  const orgId = session.user.activeOrgId;

  if (!orgId) redirect("/onboarding");

  const membership = await db.membership.findUnique({
    where: {
      userId_orgId: {
        userId: session.user.id,
        orgId,
      },
    },
  });

  if (!membership) redirect("/onboarding");

  return { session, orgId, membership };
});

/**
 * 3. The Authoritative DB Check (Defense-in-Depth)
 * ALWAYS queries the database fresh. This is what actually gates every mutation.
 * We pass the orgId the action is targeting, ensuring a user cannot tamper
 * with a request to act on an organization they don't belong to.
 */
export async function requireMembership(orgId: string): Promise<{
  userId: string;
  membership: Membership;
}> {
  const session = await requireSession();

  const membership = await db.membership.findUnique({
    where: {
      userId_orgId: {
        userId: session.user.id,
        orgId,
      },
    },
  });

  if (!membership) {
    throw new Error("You are not a member of this organization.");
  }

  return { userId: session.user.id, membership };
}

/**
 * 4. Strict Role-Based Access Control (RBAC)
 * Chains off the authoritative membership check to ensure the user currently
 * holds the necessary permissions in the database.
 *
 * Deliberately NOT cached: mutation authorization must query current membership.
 */
export async function requireRole(orgId: string, allowed: Role[]) {
  const { userId, membership } = await requireMembership(orgId);

  if (!allowed.includes(membership.role)) {
    throw new Error(`This action requires one of: ${allowed.join(", ")}.`);
  }

  return { userId, membership };
}

/**
 * 5. Dashboard Convenience Wrapper
 * Resolves the signed-in user's active organization and verifies their role.
 * Returns orgId so the route page doesn't need another lookup.
 */
export async function requireRoleForActiveOrg(allowed: Role[]) {
  const { session, orgId, membership } = await requireActiveOrg();

  // Use the current database role, not a potentially stale JWT role.
  if (!allowed.includes(membership.role)) {
    redirect(`/${membership.role.toLowerCase()}/dashboard`);
  }

  return {
    orgId,
    userId: session.user.id,
    membership,
  };
}
