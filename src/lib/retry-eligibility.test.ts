
import { describe, expect, it } from "vitest";
import { isRetryableWorkflowFinishEvent } from "@/lib/retry-eligibility";

const incidentId = "incident-1";
const workflowRunId = "run-current";

function makeEvent(
  reason: string,
  runId: string = workflowRunId,
) {
  return {
    type: "workflow_finished",
    externalId:
      `sentinel-agent-event:${incidentId}:workflow:${runId}:workflow:finished:${reason}`,
    payload: {
      workflowRunId: runId,
      reason,
    },
  };
}

describe("isRetryableWorkflowFinishEvent", () => {
  it("recognizes an exhausted workflow with reason failed", () => {
    expect(
      isRetryableWorkflowFinishEvent(
        makeEvent("failed"),
        incidentId,
        workflowRunId,
      ),
    ).toBe(true);
  });

  it("accepts other configured retryable reasons", () => {
    expect(
      isRetryableWorkflowFinishEvent(
        makeEvent("no_proposal"),
        incidentId,
        workflowRunId,
      ),
    ).toBe(true);
  });

  it("rejects an event belonging to an older workflow run", () => {
    expect(
      isRetryableWorkflowFinishEvent(
        makeEvent("failed", "run-old"),
        incidentId,
        workflowRunId,
      ),
    ).toBe(false);
  });

  it("recognizes a legacy event without a workflowRunId when its externalId matches", () => {
    expect(
      isRetryableWorkflowFinishEvent(
        {
          type: "workflow_finished",
          externalId:
            `sentinel-agent-event:${incidentId}:workflow:${workflowRunId}:workflow:finished:failed`,
          payload: { reason: "failed" },
        },
        incidentId,
        workflowRunId,
      ),
    ).toBe(true);
  });

  it("rejects a legacy event whose externalId belongs to another run", () => {
    expect(
      isRetryableWorkflowFinishEvent(
        {
          type: "workflow_finished",
          externalId:
            `sentinel-agent-event:${incidentId}:workflow:run-old:workflow:finished:failed`,
          payload: { reason: "failed" },
        },
        incidentId,
        workflowRunId,
      ),
    ).toBe(false);
  });

  it("rejects successfully resolved workflows", () => {
    expect(
      isRetryableWorkflowFinishEvent(
        makeEvent("resolved"),
        incidentId,
        workflowRunId,
      ),
    ).toBe(false);
  });

  it("rejects events when there is no current workflow run", () => {
    expect(
      isRetryableWorkflowFinishEvent(
        makeEvent("failed"),
        incidentId,
        null,
      ),
    ).toBe(false);
  });
});
