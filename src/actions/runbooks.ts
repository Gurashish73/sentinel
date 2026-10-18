
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
 * Handles creation, re-indexing, and deletion of operational runbooks.
 * Access is enforced through database-backed role checks.
 * Runbook content is chunked and embedded into pgvector for RAG retrieval.
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

/**
 * Generates embeddings and atomically replaces an existing runbook index.
 *
 * Existing chunks are not deleted until embedding generation succeeds.
 * Deletion and insertion happen in one database transaction so a failed
 * insertion rolls back the replacement.
 */
async function replaceRunbookIndex(
  runbookId: string,
  orgId: string,
  content: string,
): Promise<void> {
  const chunks = chunkText(content);

  if (chunks.length === 0) {
    throw new Error("Runbook has no indexable content.");
  }

  // Generate every embedding before modifying the existing index.
  const embeddings = await embedBatch(chunks);

  if (embeddings.length !== chunks.length) {
    throw new Error("Embedding result count does not match chunk count.");
  }

  // RunbookChunk stores vector(768).
  for (const embedding of embeddings) {
    if (
      embedding.length !== 768 ||
      embedding.some((value) => !Number.isFinite(value))
    ) {
      throw new Error("Invalid embedding dimensions or values.");
    }
  }

  // Replace the index atomically.
  await db.$transaction(async (tx) => {
    await tx.runbookChunk.deleteMany({
      where: {
        runbookId,
        orgId,
      },
    });

    for (let i = 0; i < chunks.length; i++) {
      const embedding = embeddings[i];

      if (!embedding) {
        throw new Error(`Missing embedding for chunk ${i}.`);
      }

      const vectorLiteral = `[${embedding.join(",")}]`;

      await tx.$executeRaw`
        INSERT INTO "RunbookChunk"
          (
            id,
            "runbookId",
            "orgId",
            "chunkIndex",
            content,
            embedding,
            "createdAt"
          )
        VALUES
          (
            ${randomUUID()},
            ${runbookId},
            ${orgId},
            ${i},
            ${chunks[i]},
            ${vectorLiteral}::vector,
            now()
          )
      `;
    }
  });
}

/**
 * Creates a runbook and attempts to index it for retrieval.
 *
 * The primary runbook remains saved if embedding/indexing fails.
 * The user can retry indexing using reindexRunbook().
 */
export async function createRunbook(
  _prev: RunbookState,
  formData: FormData,
): Promise<RunbookState> {
  const orgId = formData.get("orgId");

  if (typeof orgId !== "string") {
    return { message: "Missing organization." };
  }

  // Authorization stays outside the indexing error handler.
  await requireRole(orgId, ["COMMANDER", "ENGINEER"]);

  const parsed = runbookSchema.safeParse({
    orgId,
    title: formData.get("title"),
    content: formData.get("content"),
  });

  if (!parsed.success) {
    return {
      errors: parsed.error.flatten().fieldErrors,
    };
  }

  // Save the primary runbook first.
  const runbook = await db.runbook.create({
    data: parsed.data,
  });

  let indexingFailed = false;

  try {
    await replaceRunbookIndex(
      runbook.id,
      orgId,
      parsed.data.content,
    );
  } catch (error) {
    console.error(
      `[runbooks] Failed to index runbook ${runbook.id}:`,
      error,
    );

    indexingFailed = true;
  }

  updateTag(`runbooks-${orgId}`);

  return {
    message: indexingFailed
      ? "Runbook saved, but indexing failed. Use Re-index on this runbook to retry."
      : "Runbook saved.",
  };
}

/**
 * Re-indexes an existing runbook without creating a duplicate.
 * The runbook lookup is scoped to the authorized organization.
 */
export async function reindexRunbook(
  runbookId: string,
  orgId: string,
): Promise<{ success: boolean; message: string }> {
  // Keep authorization outside the catch so Next.js authorization
  // redirects and other control-flow signals can propagate correctly.
  await requireRole(orgId, ["COMMANDER", "ENGINEER"]);

  try {
    const runbook = await db.runbook.findFirst({
      where: {
        id: runbookId,
        orgId,
      },
      select: {
        id: true,
        content: true,
      },
    });

    if (!runbook) {
      return {
        success: false,
        message: "Runbook not found in this organization.",
      };
    }

    await replaceRunbookIndex(
      runbook.id,
      orgId,
      runbook.content,
    );
  } catch (error) {
    console.error(
      `[runbooks] Failed to re-index runbook ${runbookId}:`,
      error,
    );

    return {
      success: false,
      message: "Could not re-index this runbook. Please try again.",
    };
  }

  updateTag(`runbooks-${orgId}`);

  return {
    success: true,
    message: "Runbook re-indexed successfully.",
  };
}

/**
 * Deletes an existing runbook after verifying authorization and ownership.
 * Associated chunks are removed through the configured database cascade.
 */
export async function deleteRunbook(
  runbookId: string,
  orgId: string,
) {
  // Keep authorization outside the catch to preserve redirect behavior.
  await requireRole(orgId, ["COMMANDER", "ENGINEER"]);

  try {
    const runbook = await db.runbook.findFirst({
      where: {
        id: runbookId,
        orgId,
      },
    });

    if (!runbook) {
      return {
        error: "Runbook not found in this organization.",
      };
    }

    await db.runbook.delete({
      where: {
        id: runbookId,
      },
    });
  } catch (error) {
    console.error(
      `[runbooks] Failed to delete runbook ${runbookId}:`,
      error,
    );

    return {
      error: "Could not delete this runbook. Please try again.",
    };
  }

  updateTag(`runbooks-${orgId}`);

  return { success: true };
}
