import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRequireRole,
  mockTxIncidentFindFirst,
  mockTxIncidentUpdateMany,
  mockTxEventCreate,
  mockTransaction,
  mockUpdateTag,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockTxIncidentFindFirst: vi.fn(),
  mockTxIncidentUpdateMany: vi.fn(),
  mockTxEventCreate: vi.fn(),
  mockTransaction: vi.fn(),
  mockUpdateTag: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { $transaction: mockTransaction } }));
vi.mock("@/lib/dal", () => ({ requireRole: mockRequireRole }));
vi.mock("next/cache", () => ({ updateTag: mockUpdateTag }));

import { updateIncidentStatus } from "@/actions/incidents";

const tx = {
  incident: {
    findFirst: mockTxIncidentFindFirst,
    updateMany: mockTxIncidentUpdateMany,
  },
  event: { create: mockTxEventCreate },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue({ userId: "user-1" });
  mockTransaction.mockImplementation(async (callback: (client: typeof tx) => unknown) => callback(tx));
  mockTxIncidentFindFirst.mockResolvedValue({ status: "OPEN" });
  mockTxIncidentUpdateMany.mockResolvedValue({ count: 1 });
  mockTxEventCreate.mockResolvedValue({ id: "event-1" });
  mockUpdateTag.mockReturnValue(undefined);
});

describe("updateIncidentStatus", () => {
  it("rejects direct resolution because resolution belongs to the approval execution lifecycle", async () => {
    await expect(updateIncidentStatus({
      incidentId: "inc-1",
      orgId: "org-1",
      status: "RESOLVED",
    })).resolves.toEqual({ error: "Invalid status update payload." });

    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects manually setting AWAITING_APPROVAL because the agent workflow owns that transition", async () => {
    await expect(updateIncidentStatus({
      incidentId: "inc-1",
      orgId: "org-1",
      status: "AWAITING_APPROVAL",
    })).resolves.toEqual({ error: "Invalid status update payload." });

    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("atomically moves OPEN to INVESTIGATING and writes the audit event", async () => {
    await expect(updateIncidentStatus({
      incidentId: "inc-1",
      orgId: "org-1",
      status: "INVESTIGATING",
    })).resolves.toEqual({ success: true });

    expect(mockTxIncidentUpdateMany).toHaveBeenCalledWith({
      where: { id: "inc-1", orgId: "org-1", status: "OPEN" },
      data: { status: "INVESTIGATING" },
    });
    expect(mockTxEventCreate).toHaveBeenCalledWith({
      data: {
        orgId: "org-1",
        incidentId: "inc-1",
        type: "incident_status_changed",
        payload: { from: "OPEN", to: "INVESTIGATING" },
        actorId: "user-1",
      },
    });
    expect(mockUpdateTag).toHaveBeenCalledWith("incidents-org-1");
  });

  it("rejects a transition that is not allowed from the current state", async () => {
    mockTxIncidentFindFirst.mockResolvedValue({ status: "INVESTIGATING" });

    await expect(updateIncidentStatus({
      incidentId: "inc-1",
      orgId: "org-1",
      status: "INVESTIGATING",
    })).resolves.toEqual({
      error: "Invalid incident status transition: INVESTIGATING → INVESTIGATING.",
    });

    expect(mockTxIncidentUpdateMany).not.toHaveBeenCalled();
    expect(mockTxEventCreate).not.toHaveBeenCalled();
  });

  it("does not write an audit event if the compare-and-set loses a race", async () => {
    mockTxIncidentUpdateMany.mockResolvedValue({ count: 0 });

    await expect(updateIncidentStatus({
      incidentId: "inc-1",
      orgId: "org-1",
      status: "INVESTIGATING",
    })).resolves.toEqual({ error: "Incident status changed concurrently. Refresh and try again." });

    expect(mockTxEventCreate).not.toHaveBeenCalled();
    expect(mockUpdateTag).not.toHaveBeenCalled();
  });

  it("rejects transitions for incidents outside the requested organization", async () => {
    mockTxIncidentFindFirst.mockResolvedValue(null);

    await expect(updateIncidentStatus({
      incidentId: "inc-1",
      orgId: "org-other",
      status: "INVESTIGATING",
    })).resolves.toEqual({ error: "Incident not found in this organization." });

    expect(mockTxIncidentUpdateMany).not.toHaveBeenCalled();
    expect(mockTxEventCreate).not.toHaveBeenCalled();
  });
});
