import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockIncidentFindFirst,
  mockIncidentUpdateMany,
  mockRunTriage,
  mockRunDiagnosis,
  mockProposeRemediation,
  mockEmitAgentEvent,
  mockExecutionLimit,
} = vi.hoisted(() => ({
  mockIncidentFindFirst: vi.fn(),
  mockIncidentUpdateMany: vi.fn(),
  mockRunTriage: vi.fn(),
  mockRunDiagnosis: vi.fn(),
  mockProposeRemediation: vi.fn(),
  mockEmitAgentEvent: vi.fn(),
  mockExecutionLimit: vi.fn(),
}));

vi.mock("@upstash/workflow/nextjs", () => ({ serve: vi.fn((handler: unknown) => ({ POST: handler })) }));
vi.mock("@/lib/db", () => ({
  db: {
    incident: { findFirst: mockIncidentFindFirst, updateMany: mockIncidentUpdateMany },
  },
}));
vi.mock("@/agents/triage", () => ({ runTriage: mockRunTriage }));
vi.mock("@/agents/diagnosis", () => ({ runDiagnosis: mockRunDiagnosis }));
vi.mock("@/agents/remediation", () => ({ proposeRemediation: mockProposeRemediation }));
vi.mock("@/lib/emit-agent-event", () => ({
  emitAgentEvent: mockEmitAgentEvent,
  workflowEventDedupeKey: (
    workflowRunId: string,
    stage: string,
    eventName: string,
    discriminator?: string,
  ) => `workflow:${workflowRunId}:${stage}:${eventName}${discriminator === undefined ? "" : `:${discriminator}`}`,
}));
vi.mock("@/lib/rate-limit", () => ({ orgExecutionLimiter: { limit: mockExecutionLimit } }));

import { POST } from "@/app/api/workflow/agent/route";

const proposal = {
  proposalId: "proposal-test-1",
  workflowRunId: "wfr-test-run",
  action: "Restart the API service",
  riskLevel: "medium",
};

function makeContext(eventData: unknown = { approved: true, proposalId: proposal.proposalId }) {
  let executionStepResult: unknown;
  return {
    context: {
      requestPayload: { incidentId: "inc-1", orgId: "org-1" },
      workflowRunId: "wfr-test-run",
      run: vi.fn(async (_name: string, fn: () => Promise<unknown> | unknown) => {
        const result = await fn();
        if (_name === "check-blast-radius") executionStepResult = result;
        return result;
      }),
      waitForEvent: vi.fn().mockResolvedValue({ eventData, timeout: false }),
    },
    getExecutionStepResult: () => executionStepResult,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIncidentFindFirst.mockResolvedValue({
    id: "inc-1", orgId: "org-1", workflowRunId: "wfr-test-run", status: "INVESTIGATING",
    title: "DB pool exhausted", description: "Synthetic incident", severity: "HIGH",
  });
  mockIncidentUpdateMany.mockResolvedValue({ count: 1 });
  mockRunTriage.mockResolvedValue({ shouldInvestigate: true });
  mockRunDiagnosis.mockResolvedValue({ summary: "Pool exhaustion" });
  mockProposeRemediation.mockResolvedValue(proposal);
  mockEmitAgentEvent.mockResolvedValue(true);
  mockExecutionLimit.mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: Date.now() + 1000 });
});

describe("proposal-bound agent workflow", () => {
  it("waits for an approval event scoped to the current proposal", async () => {
    const { context } = makeContext();
    await POST(context as never);

    expect(context.waitForEvent).toHaveBeenCalledWith(
      "human-approval",
      "incident-inc-1-approval-proposal-test-1",
      { timeout: "1d" },
    );
  });

  it("records the exact action shown in the approved proposal", async () => {
    const { context } = makeContext();
    await POST(context as never);

    expect(mockEmitAgentEvent).toHaveBeenCalledWith(
      "org-1", "inc-1", expect.objectContaining({ type: "action_executed", action: "Restart the API service" }),
      expect.objectContaining({ dedupeKey: expect.stringContaining("proposal-test-1") }),
    );
  });

  it("escalates an approved action without executing when the org limit is exceeded", async () => {
    mockExecutionLimit.mockResolvedValue({ success: false, limit: 10, remaining: 0, reset: Date.now() + 1000, pending: Promise.resolve() });
    const { context } = makeContext();
    await POST(context as never);

    expect(mockIncidentUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "inc-1", orgId: "org-1", workflowRunId: "wfr-test-run", status: "AWAITING_APPROVAL" }),
      data: { status: "ESCALATION_REQUIRED" },
    }));
    expect(mockEmitAgentEvent).toHaveBeenCalledWith(
      "org-1", "inc-1", expect.objectContaining({ type: "blast_radius_exceeded" }),
      expect.objectContaining({ dedupeKey: expect.stringContaining("wfr-test-run") }),
    );
    expect(mockEmitAgentEvent).not.toHaveBeenCalledWith(
      "org-1", "inc-1", expect.objectContaining({ type: "action_executed" }), expect.anything(),
    );
  });

  it("does not execute when approval data belongs to a different proposal", async () => {
    const { context } = makeContext({ approved: true, proposalId: "proposal-from-another-run" });
    await POST(context as never);

    expect(mockExecutionLimit).not.toHaveBeenCalled();
    expect(mockEmitAgentEvent).not.toHaveBeenCalledWith(
      "org-1", "inc-1", expect.objectContaining({ type: "action_executed" }), expect.anything(),
    );
    expect(mockEmitAgentEvent).toHaveBeenCalledWith(
      "org-1", "inc-1", expect.objectContaining({ type: "workflow_finished", reason: "approval_mismatch" }), expect.anything(),
    );
  });

  it("finishes without waiting when remediation returns no valid proposal", async () => {
    mockProposeRemediation.mockResolvedValue(null);
    const { context } = makeContext();
    await POST(context as never);

    expect(context.waitForEvent).not.toHaveBeenCalled();
    expect(mockEmitAgentEvent).toHaveBeenCalledWith(
      "org-1", "inc-1", expect.objectContaining({ type: "workflow_finished", reason: "no_proposal" }), expect.anything(),
    );
  });
});
