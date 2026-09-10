"use server";

import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/dal";
import { updateTag } from "next/cache";
import { chunkText } from "@/lib/chunking";
import { embedBatch } from "@/lib/embeddings";
import { randomUUID } from "node:crypto";

/**
 * RUNBOOK SERVER ACTIONS
 * 
 * Handles the creation and deletion of operational runbooks. 
 * Strict Data Access Layer (DAL) checks are enforced to ensure Observers 
 * cannot tamper with the organization's automation instructions.
 * Incorporates Phase 5 RAG chunking and vector embedding upon creation.
 */

const runbookSchema = z.object({
  orgId: z.string().min(1),
  title: z.string().min(3).max(200),
  content: z.string().min(10, "Give the agent something to actually work with."),
});

export type RunbookState = { 
  errors?: Record<string, string[]>; 
  message?: string;
};

export async function createRunbook(
  _prev: RunbookState, 
  formData: FormData
): Promise<RunbookState> {
  const orgId = formData.get("orgId");
  if (typeof orgId !== "string") {
    return { message: "Missing organization." };
  }

  // 1. Authoritative Security Check
  await requireRole(orgId, ["COMMANDER", "ENGINEER"]);

  // 2. Input Sanitization
  const parsed = runbookSchema.safeParse({
    orgId,
    title: formData.get("title"),
    content: formData.get("content"),
  });
  
  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors };
  }

  // 3. Database Mutation (Store Primary Runbook)
  const runbook = await db.runbook.create({ data: parsed.data });

  // 4. Chunk, Embed, and Store in pgvector (Isolated Error Boundary)
  try {
    const chunks = chunkText(parsed.data.content);
    const embeddings = await embedBatch(chunks);

    await db.$transaction(
      chunks.map((chunkContent, i) => {
        const vectorLiteral = `[${embeddings[i].join(",")}]`;
        return db.$executeRaw`
          INSERT INTO "RunbookChunk" (id, "runbookId", "orgId", "chunkIndex", content, embedding, "createdAt")
          VALUES (${randomUUID()}, ${runbook.id}, ${orgId}, ${i}, ${chunkContent}, ${vectorLiteral}::vector, now())
        `;
      })
    );
  } catch (error) {
    console.error(`[runbooks] Failed to chunk/embed runbook ${runbook.id}:`, error);
  }
  
  // 5. Targeted Cache Invalidation
  updateTag(`runbooks-${orgId}`);
  
  return { message: "Runbook saved." };
}

export async function deleteRunbook(runbookId: string, orgId: string) {
  try {
    // 1. Enforce RBAC
    await requireRole(orgId, ["COMMANDER", "ENGINEER"]);
    
    // 2. Anti-IDOR Verification
    // Explicitly verify the runbook belongs to the user's active organization 
    // before allowing the destructive delete operation.
    const runbook = await db.runbook.findFirst({ where: { id: runbookId, orgId } });
    
    if (!runbook) {
      return { error: "Runbook not found in this organization." };
    }
    
    // 3. Destructive Mutation
    // Chunks are automatically removed via Prisma's `onDelete: Cascade` on RunbookChunk
    await db.runbook.delete({ where: { id: runbookId } });
    
    // 4. Targeted Cache Invalidation
    updateTag(`runbooks-${orgId}`);

    return { success: true };
  } catch (error) {
    // Catch DAL throws (like requireRole rejections) and return cleanly to the UI
    if (error instanceof Error) return { error: error.message };
    return { error: "An unexpected error occurred." };
  }
}