import "server-only";
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
 * Use this ONLY for pages that need *a* session, but don't touch org data.
 */
export async function requireSession() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  return session;
}

/**
 * 2. Tenant Routing Check
 * For pages that operate on "my org" (like dashboards). Trusts the JWT's 
 * activeOrgId for routing, but kicks users with no org to the onboarding flow.
 * This explicitly prevents Prisma `where: { orgId: undefined }` cross-tenant data leaks.
 */
export async function requireActiveOrg() {
  const session = await requireSession();
  if (!session.user.activeOrgId) redirect("/onboarding");
  return { session, orgId: session.user.activeOrgId };
}

/**
 * 3. The Authoritative DB Check (Defense-in-Depth)
 * ALWAYS queries the database fresh. This is what actually gates every mutation.
 * We pass the orgId the action is *targeting* (e.g., from form data), ensuring 
 * a user cannot tamper with a request to act on an org they don't belong to.
 */
export async function requireMembership(orgId: string): Promise<{
  userId: string;
  membership: Membership;
}> {
  const session = await requireSession();
  const membership = await db.membership.findUnique({
    where: { userId_orgId: { userId: session.user.id, orgId } },
  });
  
  if (!membership) {
    throw new Error("You are not a member of this organization.");
  }
  
  return { userId: session.user.id, membership };
}

/**
 * 4. Strict Role-Based Access Control (RBAC)
 * Chains off the authoritative membership check to ensure the user currently 
 * holds the necessary permissions in the database at this exact millisecond.
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
 * Resolves the signed-in user's active org AND verifies their role in one call.
 * Returns orgId alongside so the route page doesn't need a second lookup.
 */
export async function requireRoleForActiveOrg(allowed: Role[]) {
  const { orgId } = await requireActiveOrg();
  const { userId, membership } = await requireRole(orgId, allowed);
  return { orgId, userId, membership };
}