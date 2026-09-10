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

import { retrieveRelevantChunks, listRunbookTitles } from "@/lib/queries/runbook-retrieval";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("retrieveRelevantChunks", () => {
  it("embeds the query and scopes the raw query to the given orgId", async () => {
    mockEmbedText.mockResolvedValue([0.1, 0.2, 0.3]);
    mockQueryRaw.mockResolvedValue([
      { id: "c1", runbookId: "r1", runbookTitle: "Pool runbook", content: "restart the pool", similarity: 0.92 },
    ]);

    const result = await retrieveRelevantChunks("org_1", "db pool exhausted");

    expect(mockEmbedText).toHaveBeenCalledWith("db pool exhausted");
    expect(result).toHaveLength(1);
    expect(result[0].runbookTitle).toBe("Pool runbook");

    // $queryRaw is invoked as a tagged template: (strings, ...values)
    const [, ...values] = mockQueryRaw.mock.calls[0];
    expect(values).toContain("org_1");
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