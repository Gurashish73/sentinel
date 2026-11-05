import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import {
  ingestAlert,
  triggerIncidentWorkflow,
} from "@/lib/ingest-alert";
import { Prisma } from "@prisma/client";

const {
  mockIncidentCreate,
  mockEventCreate,
  mockIncidentUpdateMany,
  mockEventFindUnique,
  mockIncidentFindUnique,
  mockTrigger,
  mockEmitAgentEvent,
  mockInvestigationStartLimit,
} = vi.hoisted(() => ({
  mockIncidentCreate: vi.fn(),
  mockEventCreate: vi.fn(),
  mockIncidentUpdateMany: vi.fn(),
  mockEventFindUnique: vi.fn(),
  mockIncidentFindUnique: vi.fn(),
  mockTrigger: vi.fn(),
  mockEmitAgentEvent: vi.fn(),
  mockInvestigationStartLimit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: vi.fn((callback: (tx: unknown) => unknown) =>
      callback({
        incident: { create: mockIncidentCreate },
        event: { create: mockEventCreate },
      }),
    ),
    incident: {
      updateMany: mockIncidentUpdateMany,
      findUnique: mockIncidentFindUnique,
    },
    event: {
      findUnique: mockEventFindUnique,
    },
  },
}));

vi.mock("@upstash/workflow", () => ({
  Client: vi.fn().mockImplementation(function () {
    return { trigger: mockTrigger };
  }),
}));

// Required by the exhausted-retries path, which emits a failure event.
vi.mock("@/lib/emit-agent-event", () => ({
  emitAgentEvent: mockEmitAgentEvent,
}));

vi.mock("@/lib/rate-limit", () => ({
  investigationStartLimiter: {
    limit: mockInvestigationStartLimit,
  },
}));

const validPayload = {
  title: "Test Alert",
  severity: "HIGH" as const,
  source: "synthetic",
  externalId: "evt_123",
};

const duplicateError =
  new Prisma.PrismaClientKnownRequestError(
    "Unique constraint failed",
    {
      code: "P2002",
      clientVersion: "test",
    },
  );

beforeEach(() => {
  vi.clearAllMocks();

  mockInvestigationStartLimit.mockResolvedValue({
    success: true,
    limit: 30,
    remaining: 29,
    reset: Date.now() + 60_000,
  });

  vi.useFakeTimers();

  mockTrigger.mockResolvedValue({
    workflowRunId: "wf_run_1",
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ingestAlert", () => {
  it("creates an incident and event, then triggers the agent workflow", async () => {
    mockIncidentCreate.mockResolvedValue({ id: "inc_1" });
    mockEventCreate.mockResolvedValue({ id: "evt_1" });

    const result = await ingestAlert("org_1", validPayload);

    expect(result).toEqual({
      status: "created",
      incidentId: "inc_1",
    });

    expect(mockTrigger).toHaveBeenCalledWith({
      url: expect.stringContaining("/api/workflow/agent"),
      body: {
        incidentId: "inc_1",
        orgId: "org_1",
        attemptToken: expect.any(String),
      },
    });

    expect(mockIncidentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "inc_1",
        orgId: "org_1",
        workflowRunId: null,
        workflowAttemptToken: expect.any(String),
      },
      data: {
        workflowRunId: "wf_run_1",
      },
    });
  });

  it("stores a manual incident audit event with the acting user and starts the workflow", async () => {
    mockIncidentCreate.mockResolvedValue({ id: "inc_manual" });
    mockEventCreate.mockResolvedValue({ id: "evt_manual" });

    const result = await ingestAlert(
      "org_1",
      {
        title: "Manual incident",
        severity: "HIGH",
        source: "manual",
        externalId: "manual:test-id",
      },
      {
        eventType: "incident_created",
        actorId: "user_1",
      },
    );

    expect(result).toEqual({
      status: "created",
      incidentId: "inc_manual",
    });

    expect(mockEventCreate).toHaveBeenCalledWith({
      data: {
        orgId: "org_1",
        incidentId: "inc_manual",
        type: "incident_created",
        payload: { title: "Manual incident" },
        actorId: "user_1",
        externalId: "manual:test-id",
      },
    });

    expect(mockTrigger).toHaveBeenCalledWith({
      url: expect.stringContaining("/api/workflow/agent"),
      body: {
        incidentId: "inc_manual",
        orgId: "org_1",
        attemptToken: expect.any(String),
      },
    });
  });

  it("returns 'duplicate' and does not re-trigger when the earlier attempt already has a workflowRunId", async () => {
    mockIncidentCreate.mockResolvedValue({ id: "inc_1" });
    mockEventCreate.mockRejectedValue(duplicateError);
    mockEventFindUnique.mockResolvedValue({
      incidentId: "inc_1",
    });
    mockIncidentFindUnique.mockResolvedValue({
      workflowRunId: "wf_run_existing",
    });

    const result = await ingestAlert("org_1", validPayload);

    expect(result).toEqual({ status: "duplicate" });
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("heals a stuck incident: a duplicate delivery whose earlier attempt never got a workflow triggers one now", async () => {
    mockIncidentCreate.mockResolvedValue({ id: "inc_1" });
    mockEventCreate.mockRejectedValue(duplicateError);
    mockEventFindUnique.mockResolvedValue({
      incidentId: "inc_1",
    });
    mockIncidentFindUnique.mockResolvedValue({
      workflowRunId: null,
      workflowAttemptToken: "attempt-existing",
    });

    const result = await ingestAlert("org_1", validPayload);

    expect(result).toEqual({ status: "duplicate" });

    expect(mockTrigger).toHaveBeenCalledWith({
      url: expect.stringContaining("/api/workflow/agent"),
      body: {
        incidentId: "inc_1",
        orgId: "org_1",
        attemptToken: "attempt-existing",
      },
    });

    expect(mockIncidentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "inc_1",
        orgId: "org_1",
        workflowRunId: null,
        workflowAttemptToken: expect.any(String),
      },
      data: {
        workflowRunId: "wf_run_1",
      },
    });
  });

  it("re-throws unknown database errors instead of masking them as duplicates", async () => {
    mockIncidentCreate.mockRejectedValue(
      new Error("Database connection lost"),
    );

    await expect(
      ingestAlert("org_1", validPayload),
    ).rejects.toThrow("Database connection lost");

    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("retries the trigger call before giving up, succeeding on a later attempt", async () => {
    mockIncidentCreate.mockResolvedValue({ id: "inc_1" });
    mockEventCreate.mockResolvedValue({ id: "evt_1" });

    mockTrigger
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce({ workflowRunId: "wf_run_1" });

    const promise = ingestAlert("org_1", validPayload);

    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;

    expect(result).toEqual({
      status: "created",
      incidentId: "inc_1",
    });

    expect(mockTrigger).toHaveBeenCalledTimes(2);

    // One logical start consumes one quota check,
    // regardless of the number of QStash attempts.
    expect(mockInvestigationStartLimit).toHaveBeenCalledTimes(1);
    expect(mockInvestigationStartLimit).toHaveBeenCalledWith("org_1");
  });

  it("emits workflow_trigger_failed only after exhausting all retry attempts", async () => {
    mockIncidentCreate.mockResolvedValue({ id: "inc_1" });
    mockEventCreate.mockResolvedValue({ id: "evt_1" });

    mockTrigger.mockRejectedValue(
      new Error("persistent outage"),
    );

    const promise = ingestAlert("org_1", validPayload);

    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;

    expect(result).toEqual({
      status: "created",
      incidentId: "inc_1",
    });

    expect(mockTrigger).toHaveBeenCalledTimes(3);

    expect(mockEmitAgentEvent).toHaveBeenCalledWith(
      "org_1",
      "inc_1",
      expect.objectContaining({
        type: "workflow_trigger_failed",
      }),
    );
  });

  it("does not trigger QStash when the investigation-start limit is exhausted", async () => {
    mockIncidentCreate.mockResolvedValue({ id: "inc_1" });
    mockEventCreate.mockResolvedValue({ id: "evt_1" });

    mockInvestigationStartLimit.mockResolvedValue({
      success: false,
      limit: 30,
      remaining: 0,
      reset: Date.now() + 60_000,
    });

    const result = await ingestAlert("org_1", validPayload);

    expect(result).toEqual({
      status: "created",
      incidentId: "inc_1",
    });

    expect(mockInvestigationStartLimit).toHaveBeenCalledWith("org_1");
    expect(mockTrigger).not.toHaveBeenCalled();

    expect(mockEmitAgentEvent).toHaveBeenCalledWith(
      "org_1",
      "inc_1",
      expect.objectContaining({
        type: "workflow_trigger_failed",
      }),
    );
  });

  it("fails closed when the investigation-start limiter is unavailable", async () => {
    mockIncidentCreate.mockResolvedValue({ id: "inc_1" });
    mockEventCreate.mockResolvedValue({ id: "evt_1" });

    mockInvestigationStartLimit.mockRejectedValue(
      new Error("Redis unavailable"),
    );

    const result = await ingestAlert("org_1", validPayload);

    expect(result).toEqual({
      status: "created",
      incidentId: "inc_1",
    });

    expect(mockTrigger).not.toHaveBeenCalled();

    expect(mockEmitAgentEvent).toHaveBeenCalledWith(
      "org_1",
      "inc_1",
      expect.objectContaining({
        type: "workflow_trigger_failed",
      }),
    );
  });
});

describe("triggerIncidentWorkflow rate limiting", () => {
  it("applies the organization investigation-start limit to operator retries", async () => {
    mockTrigger.mockResolvedValue({
      workflowRunId: "wf_retry",
    });

    await expect(
      triggerIncidentWorkflow(
        "inc_retry",
        "org_1",
        "attempt-token",
      ),
    ).resolves.toBeUndefined();

    expect(mockInvestigationStartLimit).toHaveBeenCalledTimes(1);
    expect(mockInvestigationStartLimit).toHaveBeenCalledWith("org_1");

    expect(mockTrigger).toHaveBeenCalledWith({
      url: expect.stringContaining("/api/workflow/agent"),
      body: {
        incidentId: "inc_retry",
        orgId: "org_1",
        attemptToken: "attempt-token",
      },
    });

    expect(mockIncidentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "inc_retry",
        orgId: "org_1",
        workflowRunId: null,
        workflowAttemptToken: "attempt-token",
      },
      data: {
        workflowRunId: "wf_retry",
      },
    });
  });

  it("blocks operator retries when the organization's quota is exhausted", async () => {
    mockInvestigationStartLimit.mockResolvedValue({
      success: false,
      limit: 30,
      remaining: 0,
      reset: Date.now() + 60_000,
    });

    await expect(
      triggerIncidentWorkflow(
        "inc_retry",
        "org_1",
        "attempt-token",
      ),
    ).rejects.toThrow(/Investigation start limit exceeded/);

    expect(mockInvestigationStartLimit).toHaveBeenCalledWith("org_1");
    expect(mockTrigger).not.toHaveBeenCalled();
    expect(mockIncidentUpdateMany).not.toHaveBeenCalled();
  });

  it("fails closed when Redis is unavailable during an operator retry", async () => {
    mockInvestigationStartLimit.mockRejectedValue(
      new Error("Redis unavailable"),
    );

    await expect(
      triggerIncidentWorkflow(
        "inc_retry",
        "org_1",
        "attempt-token",
      ),
    ).rejects.toThrow("Redis unavailable");

    expect(mockInvestigationStartLimit).toHaveBeenCalledWith("org_1");
    expect(mockTrigger).not.toHaveBeenCalled();
    expect(mockIncidentUpdateMany).not.toHaveBeenCalled();
  });
});