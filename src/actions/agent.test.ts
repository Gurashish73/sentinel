import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRequireRole, mockIncidentFindFirst, mockEmitAgentEvent, mockNotify, mockUpdateTag, mockApprovalLimit } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(), mockIncidentFindFirst: vi.fn(), mockEmitAgentEvent: vi.fn(),
  mockNotify: vi.fn(), mockUpdateTag: vi.fn(), mockApprovalLimit: vi.fn(),
}));

vi.mock("@/lib/dal", () => ({ requireRole: mockRequireRole }));
vi.mock("@/lib/db", () => ({ db: { incident: { findFirst: mockIncidentFindFirst } } }));
vi.mock("@/lib/emit-agent-event", () => ({ emitAgentEvent: mockEmitAgentEvent }));
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

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue({ userId: "user-1" });
  mockIncidentFindFirst.mockResolvedValue({ workflowRunId: "wf-1", status: "AWAITING_APPROVAL" });
  mockEmitAgentEvent.mockResolvedValue(undefined);
  mockNotify.mockResolvedValue(undefined);
  mockApprovalLimit.mockResolvedValue({ success: true });
});

describe("Commander approval rate limiting", () => {
  it("blocks when the explicit per-user limit is exceeded", async () => {
    mockApprovalLimit.mockResolvedValue({ success: false });
    await expect(respondToProposedAction("inc-1", "org-1", true)).rejects.toThrow("Too many approval actions");
    expect(mockIncidentFindFirst).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("preserves the human approval path when limiter infrastructure is unavailable", async () => {
    mockApprovalLimit.mockRejectedValue(new Error("Redis unavailable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await respondToProposedAction("inc-1", "org-1", true);

    expect(mockNotify).toHaveBeenCalledWith({
      eventId: "incident-inc-1-approval",
      eventData: { approved: true },
      workflowRunId: "wf-1",
    });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
