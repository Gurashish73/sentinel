import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockTransaction, mockRevalidateTag } = vi.hoisted(() => ({
  mockTransaction: vi.fn(),
  mockRevalidateTag: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { $transaction: mockTransaction } }));
vi.mock("next/cache", () => ({ revalidateTag: mockRevalidateTag }));

import {
  claimApprovedExecution,
  completeApprovedExecution,
  type ApprovedProposal,
} from "@/lib/execution-lifecycle";

const input = {
  incidentId: "incident-1",
  orgId: "org-1",
  proposal: {
    proposalId: "proposal-1",
    workflowRunId: "workflow-1",
    action: "Restart the API service",
    riskLevel: "medium",
  } satisfies ApprovedProposal,
};

type StoredEvent = {
  orgId: string;
  incidentId: string;
  type: string;
  payload: unknown;
  actorId: string | null;
  externalId: string;
};

let status: string;
let events: StoredEvent[];
let tx: {
  incident: { findFirst: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  event: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
};

function seedDb(initialStatus = "AWAITING_APPROVAL") {
  status = initialStatus;
  events = [];
  tx = {
    incident: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; orgId: string; workflowRunId: string } }) => {
        if (
          where.id !== input.incidentId ||
          where.orgId !== input.orgId ||
          where.workflowRunId !== input.proposal.workflowRunId
        ) return null;
        return { status };
      }),
      updateMany: vi.fn(async ({ where, data }: {
        where: { id: string; orgId: string; workflowRunId: string; status: string };
        data: { status: string };
      }) => {
        if (
          where.id !== input.incidentId ||
          where.orgId !== input.orgId ||
          where.workflowRunId !== input.proposal.workflowRunId ||
          where.status !== status
        ) return { count: 0 };
        status = data.status;
        return { count: 1 };
      }),
    },
    event: {
      findUnique: vi.fn(async ({ where }: { where: { orgId_externalId: { orgId: string; externalId: string } } }) => {
        return events.find(
          (event) => event.orgId === where.orgId_externalId.orgId && event.externalId === where.orgId_externalId.externalId,
        ) ?? null;
      }),
      create: vi.fn(async ({ data }: { data: StoredEvent }) => {
        if (events.some((event) => event.orgId === data.orgId && event.externalId === data.externalId)) {
          throw new Error("simulated unique event-key collision");
        }
        events.push(data);
        return data;
      }),
    },
  };
  mockTransaction.mockImplementation(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx));
}

beforeEach(() => {
  vi.clearAllMocks();
  seedDb();
});

describe("proposal-bound execution lifecycle", () => {
  it("atomically claims an awaiting proposal and records its claim event", async () => {
    await expect(claimApprovedExecution(input)).resolves.toBe("claimed");

    expect(status).toBe("EXECUTING");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "action_execution_claimed",
      payload: expect.objectContaining({
        proposalId: input.proposal.proposalId,
        workflowRunId: input.proposal.workflowRunId,
        action: input.proposal.action,
      }),
    });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockRevalidateTag).toHaveBeenCalledWith("incidents-org-1", { expire: 0 });
  });

  it("does not claim an incident whose status has changed since approval", async () => {
    seedDb("OPEN");

    await expect(claimApprovedExecution(input)).resolves.toBe("superseded");
    expect(status).toBe("OPEN");
    expect(events).toHaveLength(0);
    expect(tx.incident.updateMany).not.toHaveBeenCalled();
  });

  it("allows a retry to resume the same persisted claim without duplicating it", async () => {
    await claimApprovedExecution(input);
    await expect(claimApprovedExecution(input)).resolves.toBe("claimed");

    expect(status).toBe("EXECUTING");
    expect(events.filter((event) => event.type === "action_execution_claimed")).toHaveLength(1);
  });

  it("atomically resolves the incident with the proposal-bound execution event", async () => {
    await claimApprovedExecution(input);
    await expect(completeApprovedExecution(input)).resolves.toBe("completed");

    expect(status).toBe("RESOLVED");
    expect(events.filter((event) => event.type === "action_executed")).toHaveLength(1);
    expect(events.find((event) => event.type === "action_executed")?.payload).toEqual(
      expect.objectContaining({
        proposalId: input.proposal.proposalId,
        workflowRunId: input.proposal.workflowRunId,
        action: input.proposal.action,
      }),
    );
  });

  it("treats a completed execution retry as a no-op", async () => {
    await claimApprovedExecution(input);
    await completeApprovedExecution(input);
    await expect(completeApprovedExecution(input)).resolves.toBe("completed");

    expect(status).toBe("RESOLVED");
    expect(events.filter((event) => event.type === "action_executed")).toHaveLength(1);
  });

  it("does not mark the incident resolved if the execution claim was never acquired", async () => {
    await expect(completeApprovedExecution(input)).resolves.toBe("superseded");

    expect(status).toBe("AWAITING_APPROVAL");
    expect(events.filter((event) => event.type === "action_executed")).toHaveLength(0);
  });
});
