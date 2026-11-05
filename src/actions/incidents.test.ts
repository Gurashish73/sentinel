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
  mockDbIncidentFindFirst,
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
  mockDbIncidentFindFirst: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mockTransaction,
    incident: {
      findFirst: mockDbIncidentFindFirst,
    },
  },
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

  mockTxIncidentFindFirst.mockResolvedValue({
    status: "OPEN",
    workflowRunId: null,
    workflowAttemptToken: "token-existing",
  });
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
  mockDbIncidentFindFirst.mockResolvedValue(null);
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

describe("retryIncidentInvestigation", () => {
  it("reserves a new attempt token, records the operator audit event, and triggers a retry only for a finished current run", async () => {
    mockTxIncidentFindFirst.mockResolvedValue({
      status: "OPEN",
      workflowRunId: "wf-old",
      workflowAttemptToken: "token-old",
    });

    // Match the actual Prisma Event structure.
    mockTxEventFindMany.mockResolvedValue([
      {
        type: "workflow_finished",
        externalId:
          "sentinel-agent-event:inc-1:workflow:wf-old:workflow:finished:rejected",
        payload: {
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

    expect(mockRequireRole).toHaveBeenCalledWith("org-1", [
      "COMMANDER",
    ]);

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

    // Verify that the shared eligibility query requests the complete event.
    expect(mockTxEventFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orgId: "org-1",
          incidentId: "inc-1",
          type: "workflow_finished",
          externalId: {
            startsWith:
              "sentinel-agent-event:inc-1:workflow:wf-old:workflow:finished:",
          },
        }),
        select: {
          type: true,
          externalId: true,
          payload: true,
        },
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

  it("rejects a non-retryable RESOLVED incident without reserving or triggering an attempt", async () => {
    mockTxIncidentFindFirst.mockResolvedValue({
      status: "RESOLVED",
      workflowRunId: "wf-completed",
      workflowAttemptToken: "token-completed",
    });

    await expect(
      retryIncidentInvestigation({
        incidentId: "inc-1",
        orgId: "org-1",
      }),
    ).resolves.toEqual({
      error: "This incident is not in a retryable state.",
    });

    expect(mockRequireRole).toHaveBeenCalledWith("org-1", [
      "COMMANDER",
    ]);
    expect(mockTxIncidentUpdateMany).not.toHaveBeenCalled();
    expect(mockTxEventCreate).not.toHaveBeenCalled();
    expect(mockTriggerIncidentWorkflow).not.toHaveBeenCalled();
    expect(mockTxEventFindMany).not.toHaveBeenCalled();
    expect(mockDbIncidentFindFirst).not.toHaveBeenCalled();
  });

  it("does not trigger a retry when the compare-and-set loses a race", async () => {
    mockTxIncidentFindFirst.mockResolvedValue({
      status: "OPEN",
      workflowRunId: "wf-old",
      workflowAttemptToken: "token-old",
    });

    mockTxEventFindMany.mockResolvedValue([
      {
        type: "workflow_finished",
        externalId:
          "sentinel-agent-event:inc-1:workflow:wf-old:workflow:finished:timed_out",
        payload: {
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
    expect(mockTxEventCreate).not.toHaveBeenCalled();
  });

  it("rotates the attempt token after a definite retry trigger failure and stores only a safe failure reason", async () => {
    mockTxIncidentFindFirst.mockResolvedValue({
      status: "OPEN",
      workflowRunId: "wf-old",
      workflowAttemptToken: "token-old",
    });

    mockTxEventFindMany.mockResolvedValue([
      {
        type: "workflow_finished",
        externalId:
          "sentinel-agent-event:inc-1:workflow:wf-old:workflow:finished:rejected",
        payload: {
          workflowRunId: "wf-old",
          reason: "rejected",
          ts: 1,
        },
      },
    ]);

    mockTxIncidentUpdateMany.mockResolvedValue({ count: 1 });

    const providerError = "QStash unavailable: secret internal detail";
    mockTriggerIncidentWorkflow.mockRejectedValue(new Error(providerError));

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

      const triggeredAttemptToken =
        mockTriggerIncidentWorkflow.mock.calls[0]?.[2];

      const rollbackUpdate = mockTxIncidentUpdateMany.mock.calls.at(-1)?.[0] as {
        data?: { workflowAttemptToken?: string | null };
      };

      expect(rollbackUpdate.data?.workflowAttemptToken).not.toBe(
        triggeredAttemptToken,
      );

      // The event delivered through the incident stream must not contain
      // provider error details from the failed QStash request.
      expect(mockTxEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: "workflow_trigger_failed",
            payload: expect.objectContaining({
              reason: "workflow_trigger_failed",
              ts: expect.any(Number),
            }),
          }),
        }),
      );

      const persistedFailureEvent = mockTxEventCreate.mock.calls
        .map(([args]) => args.data)
        .find((event) => event.type === "workflow_trigger_failed");

      expect(JSON.stringify(persistedFailureEvent)).not.toContain(providerError);

      // The detailed error is retained in server logs for diagnostics.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("QStash trigger failed"),
        expect.any(Error),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});