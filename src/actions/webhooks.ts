"use server";

import { requireRole } from "@/lib/dal";
import { ingestAlert } from "@/lib/ingest-alert";
import { updateTag } from "next/cache";
import { randomUUID } from "node:crypto";

/**
 * Simulates an incoming external webhook alert for testing and demonstration.
 * 
 * Security: Strictly gated to COMMANDERs.
 * Idempotency: Generates a cryptographically unique externalId per invocation.
 */
export async function simulateAlert(orgId: string) {
  // 1. Authoritative DB-backed RBAC check
  await requireRole(orgId, ["COMMANDER"]);

  try {
    // 2. Execute ingestion pipeline
    const result = await ingestAlert(orgId, {
      title: "Synthetic: DB connection pool exhausted",
      severity: "HIGH",
      source: "synthetic",
      // randomUUID guarantees no accidental deduplication on rapid UI double-clicks
      externalId: `synthetic-${randomUUID()}`, 
    });

    // 3. Cache Invalidation
    if (result.status === "created") {
      // NOTE: Using updateTag (Next.js 16+) instead of revalidateTag.
      // This forces immediate read-your-own-writes consistency rather than 
      // relying on the stale-while-revalidate default which can break UX on mutations.
      updateTag(`incidents-${orgId}`);
    }

    return { success: true, data: result };
  } catch (error) {
    // Log internally, but return a sanitized error to the Client Component
    console.error("[simulateAlert] Server Action Error:", error);
    return { success: false, error: "Failed to simulate alert. Please try again." };
  }
}