import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  incidentFindFirst: vi.fn(),
  incidentUpdateMany: vi.fn(),
  eventFindMany: vi.fn(),
  eventFindFirst: vi.fn(),
  eventCreate: vi.fn(),
  requireRole: vi.fn(),
  triggerIncidentWorkflow: vi.fn(),
  updateTag: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
    incident: {
      findFirst: mocks.incidentFindFirst,
    },
  },
}));

vi.mock("@/lib/dal", () => ({
  requireRole: mocks.requireRole,
}));

vi.mock("@/lib/ingest-alert", () => ({
  ingestAlert: vi.fn(),
  triggerIncidentWorkflow: mocks.triggerIncidentWorkflow,
}));

vi.mock("next/cache", () => ({
  updateTag: mocks.updateTag,
}));

import { retryIncidentInvestigation } from "@/actions/incidents";

type IncidentSnapshot = {
  status: string;
  workflowRunId: string | null;
  workflowAttemptToken: string | null;
};

let currentIncident: IncidentSnapshot | null;

const txClient = {
  incident: {
    findFirst: mocks.incidentFindFirst,
    updateMany: mocks.incidentUpdateMany,
  },
  event: {
    findMany: mocks.eventFindMany,
    findFirst: mocks.eventFindFirst,
    create: mocks.eventCreate,
  },
};

beforeEach(() => {
  vi.clearAllMocks();

  currentIncident = {
    status: "OPEN",
    workflowRunId: "run-failed",
    workflowAttemptToken: "token-failed",
  };

  mocks.requireRole.mockResolvedValue({
    userId: "commander-1",
  });

  mocks.triggerIncidentWorkflow.mockResolvedValue(undefined);
  mocks.updateTag.mockImplementation(() => undefined);

  mocks.incidentFindFirst.mockImplementation(async (input: unknown) => {
    if (!currentIncident) return null;

    const args = input as {
      where?: {
        status?: string | { in?: string[] };
        workflowRunId?: string | null | { not?: null };
        workflowAttemptToken?: string | null;
      };
    };

    const where = args.where ?? {};

    if (
      typeof where.status === "string" &&
      currentIncident.status !== where.status
    ) {
      return null;
    }

    if (
      where.status &&
      typeof where.status === "object" &&
      where.status.in &&
      !where.status.in.includes(currentIncident.status)
    ) {
      return null;
    }

    if (
      where.workflowRunId === null &&
      currentIncident.workflowRunId !== null
    ) {
      return null;
    }

    if (
      typeof where.workflowRunId === "string" &&
      currentIncident.workflowRunId !== where.workflowRunId
    ) {
      return null;
    }

    if (
      where.workflowRunId &&
      typeof where.workflowRunId === "object" &&
      "not" in where.workflowRunId &&
      where.workflowRunId.not === null &&
      currentIncident.workflowRunId === null
    ) {
      return null;
    }

    if (
      Object.prototype.hasOwnProperty.call(
        where,
        "workflowAttemptToken",
      ) &&
      currentIncident.workflowAttemptToken !==
        where.workflowAttemptToken
    ) {
      return null;
    }

    return { ...currentIncident };
  });

  // Use the actual Prisma Event shape:
  // type, externalId and payload are separate fields.
  mocks.eventFindMany.mockResolvedValue([
    {
      type: "workflow_finished",
      externalId:
        "sentinel-agent-event:inc-1:workflow:run-failed:workflow:finished:failed",
      payload: {
        workflowRunId: "run-failed",
        reason: "failed",
        ts: 123,
      },
    },
  ]);

  mocks.eventFindFirst.mockResolvedValue(null);
  mocks.eventCreate.mockResolvedValue({ id: "new-event" });

  mocks.incidentUpdateMany.mockImplementation(async (input: unknown) => {
    const args = input as {
      where: {
        status: string;
        workflowRunId: string | null;
        workflowAttemptToken: string | null;
      };
      data: Partial<IncidentSnapshot>;
    };

    if (
      !currentIncident ||
      currentIncident.status !== args.where.status ||
      currentIncident.workflowRunId !== args.where.workflowRunId ||
      currentIncident.workflowAttemptToken !==
        args.where.workflowAttemptToken
    ) {
      return { count: 0 };
    }

    currentIncident = {
      ...currentIncident,
      ...args.data,
    };

    return { count: 1 };
  });

  mocks.transaction.mockImplementation(async (callback: unknown) => {
    if (typeof callback !== "function") {
      throw new Error("Expected a transaction callback.");
    }

    return (
      callback as (
        client: typeof txClient,
      ) => Promise<unknown>
    )(txClient);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Commander retry after workflow failure", () => {
  it("allows retry when the current run's terminal reason is failed", async () => {
    const result = await retryIncidentInvestigation({
      incidentId: "inc-1",
      orgId: "org-1",
    });

    expect(result).toEqual({ success: true });

    expect(mocks.requireRole).toHaveBeenCalledWith(
      "org-1",
      ["COMMANDER"],
    );

    expect(mocks.eventFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orgId: "org-1",
          incidentId: "inc-1",
          type: "workflow_finished",
          externalId: {
            startsWith:
              "sentinel-agent-event:inc-1:workflow:run-failed:workflow:finished:",
          },
        }),
        select: {
          type: true,
          externalId: true,
          payload: true,
        },
      }),
    );

    expect(mocks.incidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "OPEN",
          workflowRunId: "run-failed",
          workflowAttemptToken: "token-failed",
        }),
        data: expect.objectContaining({
          status: "INVESTIGATING",
          workflowRunId: null,
          workflowAttemptToken: expect.any(String),
        }),
      }),
    );

    expect(mocks.triggerIncidentWorkflow).toHaveBeenCalledWith(
      "inc-1",
      "org-1",
      expect.any(String),
    );
  });

  it("allows retry for a stranded OPEN incident with no workflow run ID", async () => {
    currentIncident = {
      status: "OPEN",
      workflowRunId: null,
      workflowAttemptToken: null,
    };

    mocks.eventFindMany.mockResolvedValue([]);
    mocks.eventFindFirst.mockResolvedValue(null);

    const result = await retryIncidentInvestigation({
      incidentId: "inc-1",
      orgId: "org-1",
    });

    expect(result).toEqual({ success: true });
    expect(mocks.eventFindFirst).not.toHaveBeenCalled();

    expect(mocks.incidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "inc-1",
          orgId: "org-1",
          status: "OPEN",
          workflowRunId: null,
          workflowAttemptToken: null,
        }),
        data: expect.objectContaining({
          status: "INVESTIGATING",
          workflowRunId: null,
          workflowAttemptToken: expect.any(String),
        }),
      }),
    );

    expect(mocks.triggerIncidentWorkflow).toHaveBeenCalledWith(
      "inc-1",
      "org-1",
      expect.any(String),
    );
  });

  it("allows ESCALATION_REQUIRED retry only when the current run has an eligible terminal reason", async () => {
    currentIncident = {
      status: "ESCALATION_REQUIRED",
      workflowRunId: "run-failed",
      workflowAttemptToken: "token-failed",
    };

    mocks.eventFindMany.mockResolvedValue([
      {
        type: "workflow_finished",
        externalId:
          "sentinel-agent-event:inc-1:workflow:run-failed:workflow:finished:blast_radius_exceeded",
        payload: {
          workflowRunId: "run-failed",
          reason: "blast_radius_exceeded",
        },
      },
    ]);

    const result = await retryIncidentInvestigation({
      incidentId: "inc-1",
      orgId: "org-1",
    });

    expect(result).toEqual({ success: true });

    expect(mocks.incidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "ESCALATION_REQUIRED",
          workflowRunId: "run-failed",
        }),
        data: expect.objectContaining({
          status: "INVESTIGATING",
          workflowRunId: null,
        }),
      }),
    );

    expect(mocks.triggerIncidentWorkflow).toHaveBeenCalledTimes(1);
  });

  it("rejects ESCALATION_REQUIRED retry without an eligible terminal event", async () => {
    currentIncident = {
      status: "ESCALATION_REQUIRED",
      workflowRunId: "run-failed",
      workflowAttemptToken: "token-failed",
    };

    mocks.eventFindMany.mockResolvedValue([]);

    const result = await retryIncidentInvestigation({
      incidentId: "inc-1",
      orgId: "org-1",
    });

    expect(result).toEqual({
      error: "No completed or failed investigation is available to retry.",
    });

    expect(mocks.incidentUpdateMany).not.toHaveBeenCalled();
    expect(mocks.triggerIncidentWorkflow).not.toHaveBeenCalled();
  });

  it("returns success when trigger throws after the workflow has claimed this active attempt", async () => {
    mocks.triggerIncidentWorkflow.mockImplementationOnce(
      async (
        _incidentId: string,
        _orgId: string,
        token: string,
      ) => {
        currentIncident = {
          status: "INVESTIGATING",
          workflowRunId: "run-claimed",
          workflowAttemptToken: token,
        };

        throw new Error(
          "Trigger response was lost after enqueue.",
        );
      },
    );

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const result = await retryIncidentInvestigation({
      incidentId: "inc-1",
      orgId: "org-1",
    });

    expect(result).toEqual({ success: true });

    expect(currentIncident).toEqual({
      status: "INVESTIGATING",
      workflowRunId: "run-claimed",
      workflowAttemptToken: expect.any(String),
    });

    expect(mocks.incidentUpdateMany).toHaveBeenCalledTimes(2);
    expect(mocks.eventCreate).toHaveBeenCalledTimes(1);

    expect(mocks.incidentFindFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            in: [
              "INVESTIGATING",
              "AWAITING_APPROVAL",
              "EXECUTING",
            ],
          },
          workflowRunId: { not: null },
        }),
      }),
    );

    expect(errorSpy).toHaveBeenCalled();
  });

  it("preserves concurrent status changes when the rollback compare-and-set loses", async () => {
    mocks.triggerIncidentWorkflow.mockImplementationOnce(
      async (
        _incidentId: string,
        _orgId: string,
        token: string,
      ) => {
        currentIncident = {
          status: "RESOLVED",
          workflowRunId: "run-other",
          workflowAttemptToken: token,
        };

        throw new Error(
          "QStash request failed while another worker changed the incident.",
        );
      },
    );

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const result = await retryIncidentInvestigation({
      incidentId: "inc-1",
      orgId: "org-1",
    });

    expect(result).toEqual({
      error:
        "The workflow trigger failed, but the incident changed concurrently. Refresh to check its current state.",
    });

    expect(currentIncident?.status).toBe("RESOLVED");
    expect(mocks.eventCreate).toHaveBeenCalledTimes(1);

    expect(mocks.incidentFindFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            in: [
              "INVESTIGATING",
              "AWAITING_APPROVAL",
              "EXECUTING",
            ],
          },
        }),
      }),
    );

    expect(errorSpy).toHaveBeenCalled();
  });

  it("does not expose an unexpected internal error message to the caller", async () => {
    mocks.requireRole.mockRejectedValue(
      new Error("internal-db-hostname-and-secret"),
    );

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const result = await retryIncidentInvestigation({
      incidentId: "inc-1",
      orgId: "org-1",
    });

    expect(result).toEqual({
      error: "Unable to retry this investigation. Please try again.",
    });

    expect(JSON.stringify(result)).not.toContain(
      "internal-db-hostname-and-secret",
    );

    expect(errorSpy).toHaveBeenCalledWith(
      "[retryIncidentInvestigation] Unexpected failure:",
      expect.any(Error),
    );
  });
});