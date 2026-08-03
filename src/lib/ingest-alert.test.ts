import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ingestAlert } from "@/lib/ingest-alert";
import { Prisma } from "@prisma/client";

const {
  mockIncidentCreate,
  mockEventCreate,
  mockIncidentUpdate,
  mockEventFindUnique,
  mockIncidentFindUnique,
  mockTrigger,
  mockEmitAgentEvent,
} = vi.hoisted(() => ({
  mockIncidentCreate: vi.fn(),
  mockEventCreate: vi.fn(),
  mockIncidentUpdate: vi.fn(),
  mockEventFindUnique: vi.fn(),
  mockIncidentFindUnique: vi.fn(),
  mockTrigger: vi.fn(),
  mockEmitAgentEvent: vi.fn(),
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

// Required as of the retry-with-backoff logic: the exhausted-retries path
// below calls the real emitAgentEvent, which hits db.event.create — a
// method this file's db mock never stubs. Without this, that test throws
// a TypeError from inside ingestAlert's catch block instead of testing
// what it's meant to test.
vi.mock("@/lib/emit-agent-event", () => ({
  emitAgentEvent: mockEmitAgentEvent,
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
  vi.useFakeTimers();
  mockTrigger.mockResolvedValue({ workflowRunId: "wf_run_1" });
});

afterEach(() => {
  vi.useRealTimers();
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

  it("retries the trigger call before giving up, succeeding on a later attempt", async () => {
    mockIncidentCreate.mockResolvedValue({ id: "inc_1" });
    mockEventCreate.mockResolvedValue({ id: "evt_1" });
    mockTrigger
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce({ workflowRunId: "wf_run_1" });

    const promise = ingestAlert("org_1", validPayload);
    await vi.advanceTimersByTimeAsync(1000); // clears the single 500ms backoff with margin
    const result = await promise;

    expect(result).toEqual({ status: "created", incidentId: "inc_1" });
    expect(mockTrigger).toHaveBeenCalledTimes(2);
  });

  it("emits workflow_trigger_failed only after exhausting all retry attempts", async () => {
    mockIncidentCreate.mockResolvedValue({ id: "inc_1" });
    mockEventCreate.mockResolvedValue({ id: "evt_1" });
    mockTrigger.mockRejectedValue(new Error("persistent outage"));

    const promise = ingestAlert("org_1", validPayload);
    await vi.advanceTimersByTimeAsync(2000); // clears both backoff delays (500ms + 1000ms) with margin
    const result = await promise;

    expect(result).toEqual({ status: "created", incidentId: "inc_1" });
    expect(mockTrigger).toHaveBeenCalledTimes(3);
    expect(mockEmitAgentEvent).toHaveBeenCalledWith(
      "org_1",
      "inc_1",
      expect.objectContaining({ type: "workflow_trigger_failed" }),
    );
  });
});