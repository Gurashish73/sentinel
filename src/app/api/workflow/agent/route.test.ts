import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockIncidentFindFirst,
  mockIncidentUpdateMany,
  mockRunTriage,
  mockRunDiagnosis,
  mockProposeRemediation,
  mockEmitAgentEvent,
  mockExecutionLimit,
  mockClaimApprovedExecution,
  mockCompleteApprovedExecution,
  mockTransitionIncidentWithEvent,
} = vi.hoisted(() => ({
  mockIncidentFindFirst: vi.fn(),
  mockIncidentUpdateMany: vi.fn(),
  mockRunTriage: vi.fn(),
  mockRunDiagnosis: vi.fn(),
  mockProposeRemediation: vi.fn(),
  mockEmitAgentEvent: vi.fn(),
  mockExecutionLimit: vi.fn(),
  mockClaimApprovedExecution: vi.fn(),
  mockCompleteApprovedExecution: vi.fn(),
  mockTransitionIncidentWithEvent: vi.fn(),
}));

vi.mock("@upstash/workflow/nextjs", () => ({
  serve: vi.fn((handler: unknown) => ({ POST: handler })),
}));

vi.mock("@/lib/db", () => ({
  db: {
    incident: {
      findFirst: mockIncidentFindFirst,
      updateMany: mockIncidentUpdateMany,
    },
  },
}));

vi.mock("@/agents/triage", () => ({
  runTriage: mockRunTriage,
}));

vi.mock("@/agents/diagnosis", () => ({
  runDiagnosis: mockRunDiagnosis,
}));

vi.mock("@/agents/remediation", () => ({
  proposeRemediation: mockProposeRemediation,
}));

vi.mock("@/lib/emit-agent-event", () => ({
  emitAgentEvent: mockEmitAgentEvent,
  workflowEventDedupeKey: (
    workflowRunId: string,
    stage: string,
    eventName: string,
    discriminator?: string,
  ) =>
    `workflow:${workflowRunId}:${stage}:${eventName}${
      discriminator === undefined ? "" : `:${discriminator}`
    }`,
}));

vi.mock("@/lib/rate-limit", () => ({
  orgExecutionLimiter: {
    limit: mockExecutionLimit,
  },
}));

vi.mock("@/lib/execution-lifecycle", () => ({
  claimApprovedExecution: mockClaimApprovedExecution,
  completeApprovedExecution: mockCompleteApprovedExecution,
}));

vi.mock("@/lib/incident-transition", () => ({
  transitionIncidentWithEvent: mockTransitionIncidentWithEvent,
}));

import { POST } from "@/app/api/workflow/agent/route";

const proposal = {
  proposalId: "proposal-test-1",
  workflowRunId: "wfr-test-run",
  action: "Restart the API service",
  riskLevel: "medium",
};

function makeContext(
  eventData: unknown = {
    approved: true,
    proposalId: proposal.proposalId,
  },
) {
  let executionStepResult: unknown;

  return {
    context: {
      requestPayload: {
        incidentId: "inc-1",
        orgId: "org-1",
        attemptToken: undefined as string | undefined,
      },
      workflowRunId: "wfr-test-run",
      run: vi.fn(
        async (
          _name: string,
          fn: () => Promise<unknown> | unknown,
        ) => {
          const result = await fn();

          if (_name === "check-blast-radius") {
            executionStepResult = result;
          }

          return result;
        },
      ),
      waitForEvent: vi.fn().mockResolvedValue({
        eventData,
        timeout: false,
      }),
    },
    getExecutionStepResult: () => executionStepResult,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIncidentFindFirst.mockResolvedValue({
    id: "inc-1",
    orgId: "org-1",
    workflowRunId: "wfr-test-run",
    workflowAttemptToken: null,
    status: "INVESTIGATING",
    title: "DB pool exhausted",
    description: "Synthetic incident",
    severity: "HIGH",
  });
  mockIncidentUpdateMany.mockResolvedValue({ count: 1 });

  mockRunTriage.mockResolvedValue({
    shouldInvestigate: true,
  });

  mockRunDiagnosis.mockResolvedValue({
    summary: "Pool exhaustion",
  });

  mockProposeRemediation.mockResolvedValue(proposal);
  mockEmitAgentEvent.mockResolvedValue(true);
  mockClaimApprovedExecution.mockResolvedValue("claimed");
  mockCompleteApprovedExecution.mockResolvedValue("completed");
  mockTransitionIncidentWithEvent.mockResolvedValue("transitioned");

  mockExecutionLimit.mockResolvedValue({
    success: true,
    limit: 10,
    remaining: 9,
    reset: Date.now() + 1000,
  });
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

  it("claims and completes only the exact action shown in the approved proposal", async () => {
    const { context } = makeContext();
    await POST(context as never);

    expect(mockClaimApprovedExecution).toHaveBeenCalledWith({
      incidentId: "inc-1",
      orgId: "org-1",
      proposal,
    });
    expect(mockCompleteApprovedExecution).toHaveBeenCalledWith({
      incidentId: "inc-1",
      orgId: "org-1",
      proposal,
    });
  });

  it("does not complete an execution when its atomic claim was superseded", async () => {
    mockClaimApprovedExecution.mockResolvedValue("superseded");
    const { context } = makeContext();
    await POST(context as never);

    expect(mockCompleteApprovedExecution).not.toHaveBeenCalled();
    expect(mockEmitAgentEvent).toHaveBeenCalledWith(
      "org-1",
      "inc-1",
      expect.objectContaining({
        type: "workflow_finished",
        reason: "superseded",
      }),
      expect.anything(),
    );
  });

  it("does not rerun an execution that the transaction already recorded", async () => {
    mockClaimApprovedExecution.mockResolvedValue("already_executed");
    const { context } = makeContext();
    await POST(context as never);

    expect(mockCompleteApprovedExecution).not.toHaveBeenCalled();
    expect(mockEmitAgentEvent).toHaveBeenCalledWith(
      "org-1",
      "inc-1",
      expect.objectContaining({
        type: "workflow_finished",
        reason: "resolved",
      }),
      expect.anything(),
    );
  });

  it("finishes as superseded when the completion transaction loses its compare-and-set", async () => {
    mockCompleteApprovedExecution.mockResolvedValue("superseded");
    const { context } = makeContext();
    await POST(context as never);

    expect(mockEmitAgentEvent).toHaveBeenCalledWith(
      "org-1",
      "inc-1",
      expect.objectContaining({
        type: "workflow_finished",
        reason: "superseded",
      }),
      expect.anything(),
    );
  });

  it("escalates an approved action without executing when the org limit is exceeded", async () => {
    mockExecutionLimit.mockResolvedValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 1000,
      pending: Promise.resolve(),
    });

    const { context } = makeContext();
    await POST(context as never);

    expect(mockTransitionIncidentWithEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        incidentId: "inc-1",
        orgId: "org-1",
        workflowRunId: "wfr-test-run",
        fromStatus: "AWAITING_APPROVAL",
        toStatus: "ESCALATION_REQUIRED",
        event: expect.objectContaining({
          type: "blast_radius_exceeded",
        }),
        dedupeKey: expect.stringContaining("wfr-test-run"),
      }),
    );

    expect(mockEmitAgentEvent).toHaveBeenCalledWith(
      "org-1",
      "inc-1",
      expect.objectContaining({
        type: "workflow_finished",
        reason: "blast_radius_exceeded",
      }),
      expect.anything(),
    );
    expect(mockEmitAgentEvent).not.toHaveBeenCalledWith(
      "org-1",
      "inc-1",
      expect.objectContaining({
        type: "action_executed",
      }),
      expect.anything(),
    );
  });

  it("reports a timeout as superseded when the conditional lifecycle transition loses", async () => {
    mockTransitionIncidentWithEvent.mockResolvedValue("superseded");
    const { context } = makeContext();

    context.waitForEvent.mockResolvedValue({
      eventData: undefined,
      timeout: true,
    });

    await POST(context as never);

    expect(mockEmitAgentEvent).not.toHaveBeenCalledWith(
      "org-1",
      "inc-1",
      expect.objectContaining({
        type: "action_timed_out",
      }),
      expect.anything(),
    );
    expect(mockEmitAgentEvent).toHaveBeenCalledWith(
      "org-1",
      "inc-1",
      expect.objectContaining({
        type: "workflow_finished",
        reason: "superseded",
      }),
      expect.anything(),
    );
  });

  it("reports a rejection as superseded when another operation already changed the incident", async () => {
    mockTransitionIncidentWithEvent.mockResolvedValue("superseded");

    const { context } = makeContext({
      approved: false,
      proposalId: proposal.proposalId,
    });

    await POST(context as never);

    expect(mockTransitionIncidentWithEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        fromStatus: "AWAITING_APPROVAL",
        toStatus: "OPEN",
        event: expect.objectContaining({
          type: "thought",
        }),
      }),
    );

    expect(mockEmitAgentEvent).toHaveBeenCalledWith(
      "org-1",
      "inc-1",
      expect.objectContaining({
        type: "workflow_finished",
        reason: "superseded",
      }),
      expect.anything(),
    );
  });

  it("does not execute when approval data belongs to a different proposal", async () => {
    const { context } = makeContext({
      approved: true,
      proposalId: "proposal-from-another-run",
    });

    await POST(context as never);

    expect(mockExecutionLimit).not.toHaveBeenCalled();
    expect(mockEmitAgentEvent).not.toHaveBeenCalledWith(
      "org-1",
      "inc-1",
      expect.objectContaining({
        type: "action_executed",
      }),
      expect.anything(),
    );
    expect(mockEmitAgentEvent).toHaveBeenCalledWith(
      "org-1",
      "inc-1",
      expect.objectContaining({
        type: "workflow_finished",
        reason: "approval_mismatch",
      }),
      expect.anything(),
    );
  });

  it("finishes without waiting when remediation returns no valid proposal", async () => {
    mockProposeRemediation.mockResolvedValue(null);
    const { context } = makeContext();
    await POST(context as never);

    expect(context.waitForEvent).not.toHaveBeenCalled();
    expect(mockEmitAgentEvent).toHaveBeenCalledWith(
      "org-1",
      "inc-1",
      expect.objectContaining({
        type: "workflow_finished",
        reason: "no_proposal",
      }),
      expect.anything(),
    );
  });

  it("rejects a stale workflow attempt token before running the agent pipeline", async () => {
    mockIncidentUpdateMany.mockResolvedValue({ count: 0 });

    mockIncidentFindFirst.mockResolvedValue({
      id: "inc-1",
      orgId: "org-1",
      workflowRunId: "wfr-test-run",
      workflowAttemptToken: "attempt-current",
      status: "INVESTIGATING",
    });

    const { context } = makeContext();

    context.requestPayload.attemptToken = "attempt-stale";

    await POST(context as never);

    expect(mockIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workflowAttemptToken: "attempt-stale",
        }),
      }),
    );

    expect(mockRunTriage).not.toHaveBeenCalled();
    expect(mockRunDiagnosis).not.toHaveBeenCalled();
    expect(mockProposeRemediation).not.toHaveBeenCalled();

    expect(mockEmitAgentEvent).toHaveBeenCalledWith(
      "org-1",
      "inc-1",
      expect.objectContaining({
        type: "workflow_finished",
        workflowRunId: "wfr-test-run",
        reason: "superseded",
      }),
      expect.anything(),
    );
  });

  it("rejects a tokenless legacy delivery after retry rollback leaves a fencing token", async () => {
    mockIncidentUpdateMany.mockResolvedValue({ count: 0 });

    mockIncidentFindFirst.mockResolvedValue({
      id: "inc-1",
      orgId: "org-1",
      workflowRunId: "wfr-test-run",
      workflowAttemptToken: "rollback-fence-token",
      status: "INVESTIGATING",
    });

    const { context } = makeContext();
    context.requestPayload.attemptToken = undefined;

    await POST(context as never);

    expect(mockIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workflowAttemptToken: null }),
      }),
    );
    expect(mockRunTriage).not.toHaveBeenCalled();
    expect(mockRunDiagnosis).not.toHaveBeenCalled();
    expect(mockProposeRemediation).not.toHaveBeenCalled();
    expect(mockEmitAgentEvent).toHaveBeenCalledWith(
      "org-1",
      "inc-1",
      expect.objectContaining({
        type: "workflow_finished",
        workflowRunId: "wfr-test-run",
        reason: "superseded",
      }),
      expect.anything(),
    );
  });
});
