import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRequireRole,
  mockRunbookFindFirst,
  mockRunbookCreate,
  mockRunbookDelete,
  mockChunkDeleteMany,
  mockExecuteRaw,
  mockTransaction,
  mockEmbedBatch,
  mockUpdateTag,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockRunbookFindFirst: vi.fn(),
  mockRunbookCreate: vi.fn(),
  mockRunbookDelete: vi.fn(),
  mockChunkDeleteMany: vi.fn(),
  mockExecuteRaw: vi.fn(),
  mockTransaction: vi.fn(),
  mockEmbedBatch: vi.fn(),
  mockUpdateTag: vi.fn(),
}));

vi.mock("@/lib/dal", () => ({
  requireRole: mockRequireRole,
}));

vi.mock("@/lib/db", () => ({
  db: {
    runbook: {
      findFirst: mockRunbookFindFirst,
      create: mockRunbookCreate,
      delete: mockRunbookDelete,
    },
    runbookChunk: {
      deleteMany: mockChunkDeleteMany,
    },
    $transaction: mockTransaction,
  },
}));

vi.mock("@/lib/embeddings", () => ({
  embedBatch: mockEmbedBatch,
}));

vi.mock("next/cache", () => ({
  updateTag: mockUpdateTag,
}));

import { reindexRunbook } from "@/actions/runbooks";

describe("reindexRunbook", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockRequireRole.mockResolvedValue(undefined);

    mockRunbookFindFirst.mockResolvedValue({
      id: "runbook-1",
      content: "Restart the service after verifying database health.",
    });

    mockEmbedBatch.mockImplementation(async (chunks: string[]) =>
      chunks.map(() => Array(768).fill(0.01)),
    );

    mockChunkDeleteMany.mockResolvedValue({ count: 1 });
    mockExecuteRaw.mockResolvedValue(1);

    mockTransaction.mockImplementation(
      async (work: (tx: unknown) => Promise<unknown>) =>
        work({
          runbookChunk: {
            deleteMany: mockChunkDeleteMany,
          },
          $executeRaw: mockExecuteRaw,
        }),
    );
  });

  it("re-indexes the existing runbook without creating a duplicate", async () => {
    const result = await reindexRunbook("runbook-1", "org-1");

    expect(result).toEqual({
      success: true,
      message: "Runbook re-indexed successfully.",
    });

    expect(mockRequireRole).toHaveBeenCalledWith(
      "org-1",
      ["COMMANDER", "ENGINEER"],
    );

    expect(mockRunbookFindFirst).toHaveBeenCalledWith({
      where: { id: "runbook-1", orgId: "org-1" },
      select: { id: true, content: true },
    });

    expect(mockRunbookCreate).not.toHaveBeenCalled();

    expect(mockChunkDeleteMany).toHaveBeenCalledWith({
      where: { runbookId: "runbook-1", orgId: "org-1" },
    });

    expect(mockExecuteRaw).toHaveBeenCalled();
    expect(mockUpdateTag).toHaveBeenCalledWith("runbooks-org-1");
  });

  it("preserves existing chunks when embedding generation fails", async () => {
    mockEmbedBatch.mockRejectedValue(new Error("Embedding provider unavailable"));

    const result = await reindexRunbook("runbook-1", "org-1");

    expect(result.success).toBe(false);
    expect(result.message).toBe(
      "Could not re-index this runbook. Please try again.",
    );

    // Existing chunks are untouched because the transaction never starts.
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockChunkDeleteMany).not.toHaveBeenCalled();
    expect(mockRunbookCreate).not.toHaveBeenCalled();
  });

  it("does not index a runbook outside the requested organization", async () => {
    mockRunbookFindFirst.mockResolvedValue(null);

    const result = await reindexRunbook("runbook-1", "org-1");

    expect(result.success).toBe(false);
    expect(mockEmbedBatch).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockRunbookCreate).not.toHaveBeenCalled();
  });

  it("propagates authorization failures without loading or indexing a runbook", async () => {
    mockRequireRole.mockRejectedValue(new Error("Forbidden"));

    await expect(
      reindexRunbook("runbook-1", "org-1"),
    ).rejects.toThrow("Forbidden");

    expect(mockRunbookFindFirst).not.toHaveBeenCalled();
    expect(mockEmbedBatch).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("preserves the old index transactionally when a chunk insert fails", async () => {
    mockExecuteRaw.mockRejectedValue(new Error("Vector insert failed"));

    const result = await reindexRunbook("runbook-1", "org-1");

    expect(result.success).toBe(false);
    expect(mockTransaction).toHaveBeenCalledOnce();
    expect(mockChunkDeleteMany).toHaveBeenCalledOnce();
    expect(mockRunbookCreate).not.toHaveBeenCalled();
  });
});
