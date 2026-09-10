import "server-only";
import { db } from "@/lib/db";
import { embedText } from "@/lib/embeddings";

export type RetrievedChunk = {
  id: string;
  runbookId: string;
  runbookTitle: string;
  content: string;
  similarity: number;
};

export async function retrieveRelevantChunks(
  orgId: string,
  query: string,
  limit = 5,
): Promise<RetrievedChunk[]> {
  const queryEmbedding = await embedText(query);
  const vectorLiteral = `[${queryEmbedding.join(",")}]`;

  return db.$queryRaw<RetrievedChunk[]>`
    SELECT
      c.id,
      c."runbookId",
      r.title AS "runbookTitle",
      c.content,
      1 - (c.embedding <=> ${vectorLiteral}::vector) AS similarity
    FROM "RunbookChunk" c
    JOIN "Runbook" r ON r.id = c."runbookId"
    WHERE c."orgId" = ${orgId}
    ORDER BY c.embedding <=> ${vectorLiteral}::vector
    LIMIT ${limit}
  `;
}

/**
 * All runbook titles for an org, regardless of retrieval relevance — used
 * only to check whether the Diagnosis agent's summary names a real
 * runbook that wasn't actually in this incident's retrieved set (see
 * findUncitedRunbookMentions in prompt-safety.ts). Deliberately narrow
 * (titles only, no content) since this runs on every diagnosis and isn't
 * itself part of the untrusted-content path.
 */
export async function listRunbookTitles(orgId: string): Promise<string[]> {
  const runbooks = await db.runbook.findMany({
    where: { orgId },
    select: { title: true },
  });
  return runbooks.map((r) => r.title);
}