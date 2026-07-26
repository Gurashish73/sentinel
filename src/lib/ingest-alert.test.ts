import { describe, it, expect, vi, beforeEach } from "vitest";
import { ingestAlert } from "@/lib/ingest-alert";
import { Prisma } from "@prisma/client";

const { mockIncidentCreate, mockEventCreate, mockIncidentUpdate, mockEventFindUnique, mockIncidentFindUnique, mockTrigger } =
  vi.hoisted(() => ({
    mockIncidentCreate: vi.fn(),
    mockEventCreate: vi.fn(),
    mockIncidentUpdate: vi.fn(),
    mockEventFindUnique: vi.fn(),
    mockIncidentFindUnique: vi.fn(),
    mockTrigger: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: vi.fn((callback: (tx: unknown) => unknown) =>
      callback({
        incident: { create: mockIncidentCreate },
        event: { create: mockEventCreate },
      }),
    ),
    incident: { update: mockIncidentUpdate, findUnique: mockIncidentFindUnique },
    event: { findUnique: mockEventFindUnique },
  },
}));

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

const duplicateError = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
  code: "P2002",
  clientVersion: "test",
});

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
    expect(mockTrigger).toHaveBeenCalledWith({
      url: expect.stringContaining("/api/workflow/agent"),
      body: { incidentId: "inc_1", orgId: "org_1" },
    });
    expect(mockIncidentUpdate).toHaveBeenCalledWith({
      where: { id: "inc_1" },
      data: { workflowRunId: "wf_run_1", status: "INVESTIGATING" },
    });
  });

  it("returns 'duplicate' and does not re-trigger when the earlier attempt already has a workflowRunId", async () => {
    mockIncidentCreate.mockResolvedValue({ id: "inc_1" });
    mockEventCreate.mockRejectedValue(duplicateError);
    mockEventFindUnique.mockResolvedValue({ incidentId: "inc_1" });
    mockIncidentFindUnique.mockResolvedValue({ workflowRunId: "wf_run_existing" });

    const result = await ingestAlert("org_1", validPayload);

    expect(result).toEqual({ status: "duplicate" });
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("heals a stuck incident: a duplicate delivery whose earlier attempt never got a workflow triggers one now", async () => {
    // This is the recovery path: the first delivery committed the
    // transaction but the workflow trigger failed afterward (e.g. a QStash
    // network blip), leaving an incident with no workflowRunId that no
    // retry could previously fix, because it looked identical to an
    // already-fully-handled duplicate.
    mockIncidentCreate.mockResolvedValue({ id: "inc_1" });
    mockEventCreate.mockRejectedValue(duplicateError);
    mockEventFindUnique.mockResolvedValue({ incidentId: "inc_1" });
    mockIncidentFindUnique.mockResolvedValue({ workflowRunId: null });

    const result = await ingestAlert("org_1", validPayload);

    expect(result).toEqual({ status: "duplicate" });
    expect(mockTrigger).toHaveBeenCalledWith({
      url: expect.stringContaining("/api/workflow/agent"),
      body: { incidentId: "inc_1", orgId: "org_1" },
    });
    expect(mockIncidentUpdate).toHaveBeenCalledWith({
      where: { id: "inc_1" },
      data: { workflowRunId: "wf_run_1", status: "INVESTIGATING" },
    });
  });

  it("re-throws unknown database errors instead of masking them as duplicates", async () => {
    mockIncidentCreate.mockRejectedValue(new Error("Database connection lost"));
    await expect(ingestAlert("org_1", validPayload)).rejects.toThrow("Database connection lost");
    expect(mockTrigger).not.toHaveBeenCalled();
  });
});