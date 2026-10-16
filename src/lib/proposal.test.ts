import { describe, expect, it } from "vitest";
import { approvalDecisionDedupeKey, approvalEventId, createProposalId } from "@/lib/proposal";

const proposal = {
  incidentId: "inc-1",
  workflowRunId: "run-1",
  action: "Restart the API service",
  riskLevel: "medium" as const,
};

describe("proposal identity", () => {
  it("is stable across retries of the same workflow proposal", () => {
    expect(createProposalId(proposal)).toBe(createProposalId({ ...proposal }));
  });

  it("creates a different identity for a later workflow run with identical content", () => {
    expect(createProposalId({ ...proposal, workflowRunId: "run-2" })).not.toBe(createProposalId(proposal));
  });

  it("changes identity when the action or risk changes", () => {
    expect(createProposalId({ ...proposal, action: "Roll back the deployment" })).not.toBe(createProposalId(proposal));
    expect(createProposalId({ ...proposal, riskLevel: "high" })).not.toBe(createProposalId(proposal));
  });

  it("scopes both approval delivery and decision deduplication to the proposal", () => {
    const id = createProposalId(proposal);
    expect(approvalEventId("inc-1", id)).toContain(id);
    expect(approvalDecisionDedupeKey(id)).toContain(id);
    expect(approvalEventId("inc-1", id)).not.toBe(approvalEventId("inc-1", createProposalId({ ...proposal, workflowRunId: "run-2" })));
  });
});
