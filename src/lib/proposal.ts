import { createHash } from "node:crypto";

export type ProposalRiskLevel = "low" | "medium" | "high";

/**
 * Stable for retries of one durable workflow run, but different for a later
 * workflow run even when it proposes identical action text and risk.
 */
export function createProposalId(input: {
  incidentId: string;
  workflowRunId: string;
  action: string;
  riskLevel: ProposalRiskLevel;
}): string {
  const digest = createHash("sha256")
    .update([input.incidentId, input.workflowRunId, input.action, input.riskLevel].join("\0"))
    .digest("hex")
    .slice(0, 32);
  return `proposal_${digest}`;
}

export function approvalEventId(incidentId: string, proposalId: string): string {
  return `incident-${incidentId}-approval-${proposalId}`;
}

/** One first-writer-wins decision slot per concrete proposal. */
export function approvalDecisionDedupeKey(proposalId: string): string {
  return `approval-decision:${proposalId}`;
}
