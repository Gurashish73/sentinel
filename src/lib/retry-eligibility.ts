
const RETRYABLE_WORKFLOW_FINISH_REASONS: ReadonlySet<string> =
  new Set([
    "rejected",
    "timed_out",
    "skipped",
    "no_proposal",
    "approval_mismatch",
    "blast_radius_exceeded",
    "failed",
  ]);

type WorkflowFinishEventLike = {
  type: string;
  payload: unknown;
  externalId?: string | null;
};

/**
 * Determines whether an event represents a retryable finish for the
 * incident's current workflow run.
 *
 * Legacy events without workflowRunId are accepted only when their externalId
 * identifies the expected run.
 */
export function isRetryableWorkflowFinishEvent(
  event: WorkflowFinishEventLike,
  incidentId: string,
  workflowRunId: string | null,
): boolean {
  if (event.type !== "workflow_finished" || !workflowRunId) {
    return false;
  }

  if (
    event.payload === null ||
    typeof event.payload !== "object" ||
    Array.isArray(event.payload)
  ) {
    return false;
  }

  const payload = event.payload as Record<string, unknown>;

  const expectedPrefix =
    `sentinel-agent-event:${incidentId}:workflow:${workflowRunId}:workflow:finished:`;

  const legacyRunMatch =
    payload.workflowRunId === undefined &&
    typeof event.externalId === "string" &&
    event.externalId.startsWith(expectedPrefix);

  const sameRun =
    payload.workflowRunId === workflowRunId || legacyRunMatch;

  return (
    sameRun &&
    typeof payload.reason === "string" &&
    RETRYABLE_WORKFLOW_FINISH_REASONS.has(payload.reason)
  );
}
