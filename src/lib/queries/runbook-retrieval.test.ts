import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockQueryRaw, mockFindMany, mockEmbedText } = vi.hoisted(() => ({
  mockQueryRaw: vi.fn(),
  mockFindMany: vi.fn(),
  mockEmbedText: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: mockQueryRaw,
    runbook: { findMany: mockFindMany },
  },
}));

vi.mock("@/lib/embeddings", () => ({
  embedText: mockEmbedText,
}));

import {
  MIN_RUNBOOK_SIMILARITY,
  retrieveRelevantChunks,
  listRunbookTitles,
} from "@/lib/queries/runbook-retrieval";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("retrieveRelevantChunks", () => {
  it("embeds the query and scopes the raw query to the given orgId", async () => {
    mockEmbedText.mockResolvedValue([0.1, 0.2, 0.3]);
    mockQueryRaw.mockResolvedValue([
      {
        id: "c1",
        runbookId: "r1",
        runbookTitle: "Pool runbook",
        content: "restart the pool",
        similarity: 0.92,
      },
    ]);

    const result = await retrieveRelevantChunks("org_1", "db pool exhausted");

    expect(mockEmbedText).toHaveBeenCalledWith("db pool exhausted");
    expect(result).toHaveLength(1);
    expect(result[0].runbookTitle).toBe("Pool runbook");

    // $queryRaw is invoked as a tagged template: (strings, ...values)
    const [, ...values] = mockQueryRaw.mock.calls[0];
    expect(values).toContain("org_1");
    expect(values).toContain(MIN_RUNBOOK_SIMILARITY);
  });

  it("applies the SQL relevance threshold and filters weak or invalid rows", async () => {
    mockEmbedText.mockResolvedValue([0.1, 0.2, 0.3]);
    mockQueryRaw.mockResolvedValue([
      {
        id: "high",
        runbookId: "r1",
        runbookTitle: "Relevant",
        content: "Useful content",
        similarity: 0.88,
      },
      {
        id: "low",
        runbookId: "r2",
        runbookTitle: "Weak match",
        content: "Unrelated content",
        similarity: MIN_RUNBOOK_SIMILARITY - 0.01,
      },
      {
        id: "invalid",
        runbookId: "r3",
        runbookTitle: "Invalid score",
        content: "Unknown relevance",
        similarity: Number.NaN,
      },
    ]);

    const result = await retrieveRelevantChunks("org_1", "database connection pool");

    expect(result.map((chunk) => chunk.id)).toEqual(["high"]);
    expect(mockQueryRaw.mock.calls[0]?.[0].join(" ")).toContain(">=");
    expect(mockQueryRaw.mock.calls[0]?.[0].join(" ")).toContain('"RunbookChunk"');
  });

  it("passes a custom limit through to the query", async () => {
    mockEmbedText.mockResolvedValue([0.1]);
    mockQueryRaw.mockResolvedValue([]);

    await retrieveRelevantChunks("org_1", "query", 2);

    const [, ...values] = mockQueryRaw.mock.calls[0];
    expect(values).toContain(2);
  });

  it("returns an empty array when nothing matches", async () => {
    mockEmbedText.mockResolvedValue([0.1]);
    mockQueryRaw.mockResolvedValue([]);

    expect(await retrieveRelevantChunks("org_1", "no match")).toEqual([]);
  });
});

describe("listRunbookTitles", () => {
  it("returns only titles, scoped to the org", async () => {
    mockFindMany.mockResolvedValue([{ title: "A" }, { title: "B" }]);

    const titles = await listRunbookTitles("org_1");

    expect(mockFindMany).toHaveBeenCalledWith({
      where: { orgId: "org_1" },
      select: { title: true },
    });
    expect(titles).toEqual(["A", "B"]);
  });
});
