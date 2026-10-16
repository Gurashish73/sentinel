import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockFindUniqueOrThrow, mockIncidentUpdate, mockRunTriage, mockRunDiagnosis,
  mockProposeRemediation, mockEmitAgentEvent, mockExecutionLimit,
} = vi.hoisted(() => ({
  mockFindUniqueOrThrow: vi.fn(), mockIncidentUpdate: vi.fn(), mockRunTriage: vi.fn(),
  mockRunDiagnosis: vi.fn(), mockProposeRemediation: vi.fn(), mockEmitAgentEvent: vi.fn(),
  mockExecutionLimit: vi.fn(),
}));

vi.mock("@upstash/workflow/nextjs", () => ({
  serve: vi.fn((handler: unknown) => ({ POST: handler })),
}));
vi.mock("@/lib/db", () => ({
  db: { incident: { findUniqueOrThrow: mockFindUniqueOrThrow, update: mockIncidentUpdate } },
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

function makeContext() {
  let executionStepResult: unknown;
  return {
    context: {
      requestPayload: { incidentId: "inc-1", orgId: "org-1" },
      workflowRunId: "wfr-test-run",
      run: vi.fn(async (name: string, fn: () => Promise<unknown> | unknown) => {
        const result = await fn();
        if (name === "check-blast-radius") executionStepResult = result;
        return result;
      }),
      waitForEvent: vi.fn().mockResolvedValue({ eventData: { approved: true }, timeout: false }),
    },
    getExecutionStepResult: () => executionStepResult,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUniqueOrThrow.mockResolvedValue({ id: "inc-1", orgId: "org-1", title: "DB pool exhausted", description: "Synthetic incident", severity: "HIGH" });
  mockRunTriage.mockResolvedValue({ shouldInvestigate: true });
  mockRunDiagnosis.mockResolvedValue({ summary: "Pool exhaustion" });
  mockProposeRemediation.mockResolvedValue(undefined);
  mockIncidentUpdate.mockResolvedValue(undefined);
  mockEmitAgentEvent.mockResolvedValue(undefined);
  mockExecutionLimit.mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: Date.now() + 1000 });
});

describe("agent workflow Phase 6 blast-radius control", () => {
  it("escalates an approved action without executing when the org limit is exceeded", async () => {
    mockExecutionLimit.mockResolvedValue({
      success: false, limit: 10, remaining: 0, reset: Date.now() + 1000, pending: Promise.resolve(),
    });
    const { context } = makeContext();
    await POST(context as never);

    expect(mockIncidentUpdate).toHaveBeenCalledWith({
      where: { id: "inc-1" },
      data: { status: "ESCALATION_REQUIRED" },
    });
    expect(mockEmitAgentEvent).toHaveBeenCalledWith(
      "org-1", "inc-1", expect.objectContaining({ type: "blast_radius_exceeded" }),
      expect.objectContaining({ dedupeKey: expect.stringContaining("wfr-test-run") }),
    );
    expect(mockEmitAgentEvent).toHaveBeenCalledWith(
      "org-1", "inc-1", expect.objectContaining({ type: "workflow_finished", reason: "blast_radius_exceeded" }),
      expect.objectContaining({ dedupeKey: expect.stringContaining("wfr-test-run") }),
    );
    expect(mockEmitAgentEvent).not.toHaveBeenCalledWith(
      "org-1", "inc-1", expect.objectContaining({ type: "action_executed" }),
      expect.objectContaining({ dedupeKey: expect.stringContaining("wfr-test-run") }),
    );
  });

  it("executes and resolves when the org limit allows the action", async () => {
    mockExecutionLimit.mockResolvedValue({
      success: true, limit: 10, remaining: 9, reset: Date.now() + 1000, pending: Promise.resolve(),
    });
    const { context, getExecutionStepResult } = makeContext();
    await POST(context as never);

    expect(mockIncidentUpdate).toHaveBeenCalledWith({
      where: { id: "inc-1" },
      data: { status: "RESOLVED" },
    });
    expect(mockRunTriage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "inc-1" }), "org-1", "wfr-test-run",
    );
    expect(mockRunDiagnosis).toHaveBeenCalledWith(
      expect.objectContaining({ id: "inc-1" }), "org-1", "wfr-test-run",
    );
    expect(mockProposeRemediation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "inc-1" }), "org-1", { summary: "Pool exhaustion" }, "wfr-test-run",
    );
    expect(mockEmitAgentEvent).toHaveBeenCalledWith(
      "org-1", "inc-1", expect.objectContaining({ type: "action_executed" }),
      expect.objectContaining({ dedupeKey: expect.stringContaining("wfr-test-run") }),
    );
    expect(getExecutionStepResult()).toEqual(expect.objectContaining({
      success: true, limit: 10, remaining: 9,
    }));
    expect(getExecutionStepResult()).not.toHaveProperty("pending");
  });
});
