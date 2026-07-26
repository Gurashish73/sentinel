import { describe, it, expect, vi, beforeEach } from "vitest";
import { ingestAlert } from "@/lib/ingest-alert";
import { Prisma } from "@prisma/client";

// 1. Hoist the mocks so Vitest can safely access them inside vi.mock()
// without throwing a ReferenceError.
const { mockIncidentCreate, mockEventCreate, mockIncidentUpdate, mockTrigger } = vi.hoisted(() => {
  return {
    mockIncidentCreate: vi.fn(),
    mockEventCreate: vi.fn(),
    mockIncidentUpdate: vi.fn(),
    mockTrigger: vi.fn(),
  };
});

// $transaction genuinely invokes the callback it's given, with only the
// leaf Prisma calls mocked underneath — see the comment in dal.test.ts's
// sibling suites for why a shallow "just resolve a value" mock would have
// skipped the real ingestion logic entirely.
vi.mock("@/lib/db", () => ({
  db: {
    $transaction: vi.fn((callback: (tx: unknown) => unknown) =>
      callback({
        incident: { create: mockIncidentCreate },
        event: { create: mockEventCreate },
      }),
    ),
    incident: { update: mockIncidentUpdate },
  },
}));

// 2. Use a standard function here, not an arrow function, so it can be 
// correctly instantiated when ingest-alert.ts calls `new Client(...)`.
vi.mock("@upstash/workflow", () => ({
  Client: vi.fn().mockImplementation(function () {
    return { trigger: mockTrigger };
  }),
}));

const validPayload = {
  title: "Test Alert",
  severity: "HIGH" as const,
  source: "synthetic",
  externalId: "evt_123",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockTrigger.mockResolvedValue({ workflowRunId: "wf_run_1" });
});

describe("ingestAlert", () => {
  it("creates an incident and event, then triggers the agent workflow", async () => {
    mockIncidentCreate.mockResolvedValue({ id: "inc_1" });
    mockEventCreate.mockResolvedValue({ id: "evt_1" });

    const result = await ingestAlert("org_1", validPayload);

    expect(result).toEqual({ status: "created", incidentId: "inc_1" });
    expect(mockEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ orgId: "org_1", externalId: "evt_123" }),
    });

    // The trigger call is the actual new behavior this phase adds — the
    // previous test suite for this file predates the workflow existing.
    expect(mockTrigger).toHaveBeenCalledWith({
      url: expect.stringContaining("/api/workflow/agent"),
      body: { incidentId: "inc_1", orgId: "org_1" },
    });
    expect(mockIncidentUpdate).toHaveBeenCalledWith({
      where: { id: "inc_1" },
      data: { workflowRunId: "wf_run_1", status: "INVESTIGATING" },
    });
  });

  it("does not trigger a workflow for a duplicate delivery", async () => {
    mockIncidentCreate.mockResolvedValue({ id: "inc_1" });
    mockEventCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

    const result = await ingestAlert("org_1", validPayload);

    expect(result).toEqual({ status: "duplicate" });
    // This is the case worth being paranoid about: a retried webhook must
    // never kick off a second investigation for the same alert.
    expect(mockTrigger).not.toHaveBeenCalled();
    expect(mockIncidentUpdate).not.toHaveBeenCalled();
  });

  it("re-throws unknown database errors instead of masking them as duplicates", async () => {
    mockIncidentCreate.mockRejectedValue(new Error("Database connection lost"));
    await expect(ingestAlert("org_1", validPayload)).rejects.toThrow("Database connection lost");
    expect(mockTrigger).not.toHaveBeenCalled();
  });
});