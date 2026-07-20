import "server-only";
import { db } from "@/lib/db";
import { unstable_cache } from "next/cache";

/**
 * INCIDENT QUERIES
 * 
 * All queries in this file MUST explicitly enforce the orgId multi-tenant boundary.
 * We wrap Prisma calls in Next.js `unstable_cache` to prevent redundant database 
 * hits during Server Component rendering. 
 * 
 * Cache entries are tagged with "incidents" so our Server Actions can instantly 
 * invalidate them globally via `revalidateTag("incidents")` after mutations.
 */

export function getIncidentsForOrg(orgId: string) {
  return unstable_cache(
    async () =>
      db.incident.findMany({
        where: { orgId },
        orderBy: { createdAt: "desc" },
      }),
    // The cache key strictly isolates data by organization
    [`incidents-${orgId}`],
    { tags: [`incidents-${orgId}`] },
  )();
}

export function getIncidentById(id: string, orgId: string) {
  return unstable_cache(
    async () =>
      db.incident.findFirst({
        // orgId in the where clause is critical. This is what stops a user 
        // from viewing another org's incident by guessing a URL id.
        where: { id, orgId },
        include: {
          events: { orderBy: { createdAt: "asc" } },
        },
      }),
    [`incident-${id}-${orgId}`],
    { tags: [`incidents-${orgId}`] },
  )();
}