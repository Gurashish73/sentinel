import "server-only";
import { db } from "@/lib/db";
import { unstable_cache } from "next/cache";

/**
 * RUNBOOK QUERIES
 * 
 * All queries in this file explicitly enforce the orgId multi-tenant boundary.
 * Next.js `unstable_cache` is used to prevent redundant database hits during 
 * Server Component rendering, drastically speeding up the Runbook Library UI.
 * 
 * Cache entries are tagged with "runbooks" so our Server Actions can instantly 
 * invalidate them globally via `revalidateTag("runbooks")` after mutations.
 */

export function getRunbooksForOrg(orgId: string) {
  return unstable_cache(
    async () =>
      db.runbook.findMany({
        where: { orgId },
        orderBy: { createdAt: "desc" },
      }),
    // The cache key strictly isolates data by organization
    [`runbooks-${orgId}`],
    // Scope the invalidation tag specifically to this tenant
    { tags: [`runbooks-${orgId}`] },
  )();
}

export function getRunbookById(id: string, orgId: string) {
  return unstable_cache(
    async () => 
      db.runbook.findFirst({ 
        // orgId in the where clause acts as an anti-IDOR shield.
        where: { id, orgId } 
      }),
    [`runbook-${id}-${orgId}`],
    { tags: [`runbooks-${orgId}`] },
  )();
}