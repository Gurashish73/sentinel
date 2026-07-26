import "server-only";

/**
 * MOCK — there's no real log aggregator wired up yet. Returns fabricated
 * but plausible log lines so the Diagnosis agent has something concrete to
 * reason over. Swap this for a real provider (Datadog, CloudWatch, etc.)
 * later without touching any agent logic that calls it — that's the whole
 * point of keeping it behind this one function.
 */
export async function fetchRecentLogs(incidentTitle: string): Promise<string[]> {
  return [
    "[ERROR] Connection pool exhausted: 100/100 connections in use",
    "[WARN] Query queue depth exceeded threshold (847 pending)",
    "[ERROR] Timeout acquiring connection after 30000ms",
    `[INFO] Related incident title for context: "${incidentTitle}"`,
  ];
}