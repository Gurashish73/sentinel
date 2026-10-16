import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockRequireRole,
  mockIncidentFindFirst,
  mockEventFindFirst,
  mockEmitAgentEvent,
  mockNotify,
  mockUpdateTag,
  mockApprovalLimit,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockIncidentFindFirst: vi.fn(),
  mockEventFindFirst: vi.fn(),
  mockEmitAgentEvent: vi.fn(),
  mockNotify: vi.fn(),
  mockUpdateTag: vi.fn(),
  mockApprovalLimit: vi.fn(),
}));

vi.mock("@/lib/dal", () => ({ requireRole: mockRequireRole }));
vi.mock("@/lib/db", () => ({
  db: {
    incident: { findFirst: mockIncidentFindFirst },
    event: { findFirst: mockEventFindFirst },
  },
}));
vi.mock("@/lib/emit-agent-event", () => ({
  emitAgentEvent: mockEmitAgentEvent,
  dedupeExternalId: (incidentId: string, key: string) => `sentinel-agent-event:${incidentId}:${key}`,
}));
vi.mock("@upstash/workflow", () => {
  class MockClient {
    constructor() {}
    notify = mockNotify;
  }
  return { Client: MockClient };
});
vi.mock("@/lib/env", () => ({ env: { QSTASH_TOKEN: "test-token" } }));
vi.mock("next/cache", () => ({ updateTag: mockUpdateTag }));
vi.mock("@/lib/rate-limit", () => ({ approvalActionLimiter: { limit: mockApprovalLimit } }));

import { respondToProposedAction } from "@/actions/agent";

const proposalId = "proposal_123";
const latestProposalEvent = {
  payload: {
    type: "action_proposed",
    proposalId,
    workflowRunId: "wf-1",
    action: "Restart API",
    riskLevel: "medium",
    ts: 123,
  },
};
let existingDecision: { type: string; payload: unknown } | null;

beforeEach(() => {
  vi.clearAllMocks();
  existingDecision = null;
  mockRequireRole.mockResolvedValue({ userId: "user-1" });
  mockIncidentFindFirst.mockResolvedValue({ workflowRunId: "wf-1", status: "AWAITING_APPROVAL" });
  mockEventFindFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    if (where.type === "action_proposed") return latestProposalEvent;
    if (typeof where.externalId === "string") return existingDecision;
    return null;
  });
  mockEmitAgentEvent.mockResolvedValue(true);
  mockNotify.mockResolvedValue(undefined);
  mockApprovalLimit.mockResolvedValue({ success: true });
});

describe("proposal-bound Commander decisions", () => {
  it("returns a readable error when the explicit approval rate limit is exceeded", async () => {
    mockApprovalLimit.mockResolvedValue({ success: false });
    await expect(respondToProposedAction("inc-1", "org-1", proposalId, true)).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("Too many approval actions"),
    });
    expect(mockIncidentFindFirst).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("preserves approval availability when Redis is unavailable and notifies the exact proposal", async () => {
    mockApprovalLimit.mockRejectedValue(new Error("Redis unavailable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(respondToProposedAction("inc-1", "org-1", proposalId, true)).resolves.toEqual({ ok: true });

    expect(mockEmitAgentEvent).toHaveBeenCalledWith(
      "org-1",
      "inc-1",
      expect.objectContaining({ type: "action_approved", actorId: "user-1", proposalId }),
      { dedupeKey: `approval-decision:${proposalId}` },
    );
    expect(mockNotify).toHaveBeenCalledWith({
      eventId: `incident-inc-1-approval-${proposalId}`,
      eventData: { approved: true, proposalId },
      workflowRunId: "wf-1",
    });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("rejects a stale proposal ID without recording or notifying a decision", async () => {
    await expect(respondToProposedAction("inc-1", "org-1", "proposal-from-old-run", true)).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("stale"),
    });
    expect(mockEmitAgentEvent).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("does not allow a reject to overwrite an already recorded approval", async () => {
    mockEmitAgentEvent.mockResolvedValue(false);
    existingDecision = {
      type: "action_approved",
      payload: { type: "action_approved", proposalId, actorId: "user-2", ts: 123 },
    };

    await expect(respondToProposedAction("inc-1", "org-1", proposalId, false)).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("different decision"),
    });
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("allows a retry of the same decision to re-notify the same workflow event", async () => {
    mockEmitAgentEvent.mockResolvedValue(false);
    existingDecision = {
      type: "action_approved",
      payload: { type: "action_approved", proposalId, actorId: "user-1", ts: 123 },
    };

    await expect(respondToProposedAction("inc-1", "org-1", proposalId, true)).resolves.toEqual({ ok: true });
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });
});
