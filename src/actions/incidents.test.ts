import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRequireRole,
  mockTxIncidentFindFirst,
  mockTxIncidentUpdateMany,
  mockTxEventCreate,
  mockTransaction,
  mockUpdateTag,
  mockIngestAlert,
  mockTriggerIncidentWorkflow,
  mockTxEventFindMany,
  mockTxEventFindFirst,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockTxIncidentFindFirst: vi.fn(),
  mockTxIncidentUpdateMany: vi.fn(),
  mockTxEventCreate: vi.fn(),
  mockTransaction: vi.fn(),
  mockUpdateTag: vi.fn(),
  mockIngestAlert: vi.fn(),
  mockTriggerIncidentWorkflow: vi.fn(),
  mockTxEventFindMany: vi.fn(),
  mockTxEventFindFirst: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { $transaction: mockTransaction },
}));

vi.mock("@/lib/dal", () => ({
  requireRole: mockRequireRole,
}));

vi.mock("next/cache", () => ({
  updateTag: mockUpdateTag,
}));

vi.mock("@/lib/ingest-alert", () => ({
  ingestAlert: mockIngestAlert,
  triggerIncidentWorkflow: mockTriggerIncidentWorkflow,
}));

import {
  createIncident,
  retryIncidentInvestigation,
  updateIncidentStatus,
} from "@/actions/incidents";

const tx = {
  incident: {
    findFirst: mockTxIncidentFindFirst,
    updateMany: mockTxIncidentUpdateMany,
  },
  event: {
    create: mockTxEventCreate,
    findMany: mockTxEventFindMany,
    findFirst: mockTxEventFindFirst,
  },
};

beforeEach(() => {
  vi.clearAllMocks();

  mockRequireRole.mockResolvedValue({ userId: "user-1" });

  mockTransaction.mockImplementation(
    async (callback: (client: typeof tx) => unknown) => callback(tx),
  );

  mockTxIncidentFindFirst.mockResolvedValue({ status: "OPEN" });
  mockTxIncidentUpdateMany.mockResolvedValue({ count: 1 });
  mockTxEventCreate.mockResolvedValue({ id: "event-1" });
  mockUpdateTag.mockReturnValue(undefined);

  mockIngestAlert.mockResolvedValue({
    status: "created",
    incidentId: "inc-1",
  });

  mockTriggerIncidentWorkflow.mockResolvedValue(undefined);
  mockTxEventFindMany.mockResolvedValue([]);
  mockTxEventFindFirst.mockResolvedValue(null);
});

describe("createIncident", () => {
  it("creates a manual incident through the transactional ingestion and workflow path", async () => {
    const formData = new FormData();

    formData.set("orgId", "org-1");
    formData.set("title", "Manual incident");
    formData.set("description", "Created by an engineer");
    formData.set("severity", "HIGH");

    await expect(createIncident({}, formData)).resolves.toEqual({
      message: "Incident created.",
    });

    expect(mockRequireRole).toHaveBeenCalledWith("org-1", [
      "COMMANDER",
      "ENGINEER",
    ]);

    expect(mockIngestAlert).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        title: "Manual incident",
        description: "Created by an engineer",
        severity: "HIGH",
        source: "manual",
        externalId: expect.stringMatching(/^manual:/),
      }),
      {
        eventType: "incident_created",
        actorId: "user-1",
      },
    );

    expect(mockUpdateTag).toHaveBeenCalledWith("incidents-org-1");
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

describe("updateIncidentStatus", () => {
  it("rejects direct resolution because resolution belongs to the approval execution lifecycle", async () => {
    await expect(
      updateIncidentStatus({
        incidentId: "inc-1",
        orgId: "org-1",
        status: "RESOLVED",
      }),
    ).resolves.toEqual({
      error: "Invalid status update payload.",
    });

    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects manually setting AWAITING_APPROVAL because the agent workflow owns that transition", async () => {
    await expect(
      updateIncidentStatus({
        incidentId: "inc-1",
        orgId: "org-1",
        status: "AWAITING_APPROVAL",
      }),
    ).resolves.toEqual({
      error: "Invalid status update payload.",
    });

    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("does not allow a status-only update to start an investigation", async () => {
    await expect(
      updateIncidentStatus({
        incidentId: "inc-1",
        orgId: "org-1",
        status: "INVESTIGATING",
      }),
    ).resolves.toEqual({
      error: "Invalid incident status transition: OPEN → INVESTIGATING.",
    });

    expect(mockTxIncidentUpdateMany).not.toHaveBeenCalled();
    expect(mockTxEventCreate).not.toHaveBeenCalled();
    expect(mockUpdateTag).not.toHaveBeenCalled();
  });

  it("rejects a transition that is not allowed from the current state", async () => {
    mockTxIncidentFindFirst.mockResolvedValue({
      status: "INVESTIGATING",
    });

    await expect(
      updateIncidentStatus({
        incidentId: "inc-1",
        orgId: "org-1",
        status: "INVESTIGATING",
      }),
    ).resolves.toEqual({
      error: "Invalid incident status transition: INVESTIGATING → INVESTIGATING.",
    });

    expect(mockTxIncidentUpdateMany).not.toHaveBeenCalled();
    expect(mockTxEventCreate).not.toHaveBeenCalled();
  });

  it("rejects transitions for incidents outside the requested organization", async () => {
    mockTxIncidentFindFirst.mockResolvedValue(null);

    await expect(
      updateIncidentStatus({
        incidentId: "inc-1",
        orgId: "org-other",
        status: "INVESTIGATING",
      }),
    ).resolves.toEqual({
      error: "Incident not found in this organization.",
    });

    expect(mockTxIncidentUpdateMany).not.toHaveBeenCalled();
    expect(mockTxEventCreate).not.toHaveBeenCalled();
  });
});

describe("retryIncidentInvestigation", () => {
  it("reserves a new attempt token, records the operator audit event, and triggers a retry only for a finished current run", async () => {
    mockTxIncidentFindFirst.mockResolvedValue({
      status: "OPEN",
      workflowRunId: "wf-old",
      workflowAttemptToken: "token-old",
    });

    mockTxEventFindMany.mockResolvedValue([
      {
        payload: {
          type: "workflow_finished",
          workflowRunId: "wf-old",
          reason: "rejected",
          ts: 1,
        },
      },
    ]);

    await expect(
      retryIncidentInvestigation({
        incidentId: "inc-1",
        orgId: "org-1",
      }),
    ).resolves.toEqual({ success: true });

    // Authorization must be checked against the current organization.
    expect(mockRequireRole).toHaveBeenCalledWith("org-1", ["COMMANDER"]);

    // The reservation must match the current state and previous attempt.
    expect(mockTxIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "inc-1",
          orgId: "org-1",
          status: "OPEN",
          workflowRunId: "wf-old",
          workflowAttemptToken: "token-old",
        }),
        data: expect.objectContaining({
          status: "INVESTIGATING",
          workflowRunId: null,
          workflowAttemptToken: expect.any(String),
        }),
      }),
    );

    // The audit record must identify the operator who requested the retry.
    expect(mockTxEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orgId: "org-1",
          incidentId: "inc-1",
          type: "incident_status_changed",
          payload: {
            from: "OPEN",
            to: "INVESTIGATING",
            reason: "operator_retry",
          },
          actorId: "user-1",
        }),
      }),
    );

    // Only the newly reserved attempt may be triggered.
    expect(mockTriggerIncidentWorkflow).toHaveBeenCalledWith(
      "inc-1",
      "org-1",
      expect.any(String),
    );

    expect(mockUpdateTag).toHaveBeenCalledWith("incidents-org-1");
  });

  it("does not trigger a retry when the compare-and-set loses a race", async () => {
    mockTxIncidentFindFirst.mockResolvedValue({
      status: "OPEN",
      workflowRunId: "wf-old",
      workflowAttemptToken: "token-old",
    });

    mockTxEventFindMany.mockResolvedValue([
      {
        payload: {
          type: "workflow_finished",
          workflowRunId: "wf-old",
          reason: "timed_out",
          ts: 1,
        },
      },
    ]);

    mockTxIncidentUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      retryIncidentInvestigation({
        incidentId: "inc-1",
        orgId: "org-1",
      }),
    ).resolves.toEqual({
      error: "Incident changed concurrently. Refresh and try again.",
    });

    expect(mockTriggerIncidentWorkflow).not.toHaveBeenCalled();
  });

  it("rotates the attempt token after a definite retry trigger failure", async () => {
    mockTxIncidentFindFirst.mockResolvedValue({
      status: "OPEN",
      workflowRunId: "wf-old",
      workflowAttemptToken: "token-old",
    });

    mockTxEventFindMany.mockResolvedValue([
      {
        payload: {
          type: "workflow_finished",
          workflowRunId: "wf-old",
          reason: "rejected",
          ts: 1,
        },
      },
    ]);

    mockTxIncidentUpdateMany.mockResolvedValue({ count: 1 });

    mockTriggerIncidentWorkflow.mockRejectedValue(
      new Error("QStash unavailable"),
    );

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      await expect(
        retryIncidentInvestigation({
          incidentId: "inc-1",
          orgId: "org-1",
        }),
      ).resolves.toEqual({
        error: "The workflow trigger failed. The incident is open and can be retried.",
      });

      expect(mockTxIncidentUpdateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: "INVESTIGATING",
            workflowRunId: null,
            workflowAttemptToken: expect.any(String),
          }),
          data: {
            status: "OPEN",
            workflowAttemptToken: expect.any(String),
          },
        }),
      );

      const triggeredAttemptToken = mockTriggerIncidentWorkflow.mock.calls[0]?.[2];
      const rollbackUpdate = mockTxIncidentUpdateMany.mock.calls.at(-1)?.[0] as {
        data?: { workflowAttemptToken?: string | null };
      };
      expect(rollbackUpdate.data?.workflowAttemptToken).not.toBe(triggeredAttemptToken);

      expect(mockTxEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: "workflow_trigger_failed",
          }),
        }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});