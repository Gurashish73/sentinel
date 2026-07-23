import { describe, it, expect, vi, beforeEach } from "vitest";
import { ingestAlert } from "@/lib/ingest-alert";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";

// Mocks the $transaction method itself, as that is the top-level 
// database boundary hit by our ingestAlert function.
vi.mock("@/lib/db", () => ({
  db: {
    $transaction: vi.fn(),
  },
}));

const mockTransaction = vi.mocked(db.$transaction);

const validPayload = {
  title: "Test Alert",
  severity: "HIGH" as const,
  source: "synthetic",
  externalId: "evt_123",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ingestAlert", () => {
  it("creates an incident and event successfully", async () => {
    // Simulate the transaction callback resolving successfully
    mockTransaction.mockResolvedValue({ status: "created", incidentId: "inc_1" } as never);

    const result = await ingestAlert("org_1", validPayload);

    expect(result).toEqual({ status: "created", incidentId: "inc_1" });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it("returns 'duplicate' when Prisma throws a P2002 Unique Constraint error", async () => {
    // Simulate the database rejecting the transaction due to the @@unique constraint
    const p2002Error = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      { code: "P2002", clientVersion: "latest" }
    );
    mockTransaction.mockRejectedValue(p2002Error);

    const result = await ingestAlert("org_1", validPayload);

    // It should gracefully swallow the error and return the duplicate status
    expect(result).toEqual({ status: "duplicate" });
  });

  it("re-throws unknown database errors", async () => {
    const unknownError = new Error("Database connection lost");
    mockTransaction.mockRejectedValue(unknownError);

    await expect(ingestAlert("org_1", validPayload)).rejects.toThrow("Database connection lost");
  });
});