import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockTxIncidentFindFirst,
  mockTxIncidentUpdateMany,
  mockTxEventFindUnique,
  mockTxEventCreate,
  mockTransaction,
  mockRevalidateTag,
} = vi.hoisted(() => ({
  mockTxIncidentFindFirst: vi.fn(),
  mockTxIncidentUpdateMany: vi.fn(),
  mockTxEventFindUnique: vi.fn(),
  mockTxEventCreate: vi.fn(),
  mockTransaction: vi.fn(),
  mockRevalidateTag: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mockTransaction,
  },
}));

vi.mock("next/cache", () => ({ revalidateTag: mockRevalidateTag }));

import { transitionIncidentWithEvent } from "@/lib/incident-transition";

const tx = {
  incident: {
    findFirst: mockTxIncidentFindFirst,
    updateMany: mockTxIncidentUpdateMany,
  },
  event: {
    findUnique: mockTxEventFindUnique,
    create: mockTxEventCreate,
  },
};

const input = {
  incidentId: "inc-1",
  orgId: "org-1",
  workflowRunId: "run-1",
  fromStatus: "AWAITING_APPROVAL" as const,
  toStatus: "OPEN" as const,
  event: { type: "action_timed_out" as const, ts: 123 },
  dedupeKey: "workflow:run-1:workflow:action-timed-out",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockTransaction.mockImplementation(async (callback: (client: typeof tx) => unknown) => callback(tx));
  mockTxIncidentFindFirst.mockResolvedValue({ status: "AWAITING_APPROVAL" });
  mockTxIncidentUpdateMany.mockResolvedValue({ count: 1 });
  mockTxEventFindUnique.mockResolvedValue(null);
  mockTxEventCreate.mockResolvedValue({ id: "event-1" });
  mockRevalidateTag.mockReturnValue(undefined);
});

describe("workflow-owned incident transitions", () => {
  it("atomically records the state transition and its deduplicated lifecycle event", async () => {
    await expect(transitionIncidentWithEvent(input)).resolves.toBe("transitioned");

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockTxIncidentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "inc-1",
        orgId: "org-1",
        workflowRunId: "run-1",
        status: "AWAITING_APPROVAL",
      },
      data: { status: "OPEN" },
    });
    expect(mockTxEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orgId: "org-1",
        incidentId: "inc-1",
        type: "action_timed_out",
        externalId: "sentinel-agent-event:inc-1:workflow:run-1:workflow:action-timed-out",
      }),
    });
    expect(mockRevalidateTag).toHaveBeenCalledWith("incidents-org-1", { expire: 0 });
  });

  it("does not emit a lifecycle event when the incident is no longer in the expected source state", async () => {
    mockTxIncidentFindFirst.mockResolvedValue({ status: "RESOLVED" });

    await expect(transitionIncidentWithEvent(input)).resolves.toBe("superseded");

    expect(mockTxIncidentUpdateMany).not.toHaveBeenCalled();
    expect(mockTxEventCreate).not.toHaveBeenCalled();
    expect(mockRevalidateTag).not.toHaveBeenCalled();
  });

  it("recognizes an identical durable-step replay without inserting a duplicate event", async () => {
    mockTxIncidentFindFirst.mockResolvedValue({ status: "OPEN" });
    mockTxEventFindUnique.mockResolvedValue({
      type: "action_timed_out",
      payload: { type: "action_timed_out", ts: 123 },
    });

    await expect(transitionIncidentWithEvent(input)).resolves.toBe("transitioned");

    expect(mockTxIncidentUpdateMany).not.toHaveBeenCalled();
    expect(mockTxEventCreate).not.toHaveBeenCalled();
    expect(mockRevalidateTag).toHaveBeenCalledWith("incidents-org-1", { expire: 0 });
  });

  it("propagates audit-write failure so the database transaction can roll back", async () => {
    const error = new Error("event store unavailable");
    mockTxEventCreate.mockRejectedValue(error);

    await expect(transitionIncidentWithEvent(input)).rejects.toBe(error);
    // Prisma transaction rollback is provided by the real $transaction boundary.
    expect(mockTxIncidentUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockTxEventCreate).toHaveBeenCalledTimes(1);
  });
});
