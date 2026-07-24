import { describe, it, expect, vi, beforeEach } from "vitest";
import { ingestAlert } from "@/lib/ingest-alert";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";

// Mocking $transaction to just resolve a canned value would skip the
// callback entirely — the actual incident/event-creation logic would never
// run, and this suite would only prove "ingestAlert returns whatever
// $transaction returns," not that ingestion itself works. Instead, the
// mocked $transaction genuinely invokes the real callback it's given, with
// only the leaf Prisma calls (tx.incident.create, tx.event.create) mocked.
const mockIncidentCreate = vi.fn();
const mockEventCreate = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: vi.fn((callback: (tx: unknown) => unknown) =>
      callback({
        incident: { create: mockIncidentCreate },
        event: { create: mockEventCreate },
      }),
    ),
  },
}));

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
  it("creates an incident and a matching event, scoped to the right org", async () => {
    mockIncidentCreate.mockResolvedValue({ id: "inc_1" });
    mockEventCreate.mockResolvedValue({ id: "evt_1" });

    const result = await ingestAlert("org_1", validPayload);

    expect(result).toEqual({ status: "created", incidentId: "inc_1" });

    // This is the part the previous version never actually verified: that
    // the data handed to Prisma is correct, not just that some value came
    // back out the other end.
    expect(mockIncidentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orgId: "org_1",
        title: validPayload.title,
        severity: validPayload.severity,
      }),
    });
    expect(mockEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orgId: "org_1",
        incidentId: "inc_1",
        type: "alert_received",
        externalId: "evt_123",
      }),
    });
  });

  it("returns 'duplicate' when the event write hits the (orgId, externalId) unique constraint", async () => {
    mockIncidentCreate.mockResolvedValue({ id: "inc_1" });
    mockEventCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

    const result = await ingestAlert("org_1", validPayload);
    expect(result).toEqual({ status: "duplicate" });
  });

  it("re-throws unknown database errors instead of masking them as duplicates", async () => {
    mockIncidentCreate.mockRejectedValue(new Error("Database connection lost"));
    await expect(ingestAlert("org_1", validPayload)).rejects.toThrow("Database connection lost");
  });
});