"use client";

import { ApprovalControls,
  type ProposalView, } from "@/components/approval-controls";
import { StatusControls } from "@/components/status-controls";
import { useIncidentStreamContext } from "@/components/incident-stream-provider";
import type { Role } from "@prisma/client";

function isProposalRiskLevel(
  value: unknown,
): value is ProposalView["riskLevel"] {
  return value === "low" || value === "medium" || value === "high";
}

export function IncidentTimelinePanel({
  incident,
  orgId,
  role,
}: {
  incident: { id: string; title: string; description: string | null; severity: string; workflowRunId: string | null };
  orgId: string;
  role: Role;
}) {
  // Pull live status and the proposal event from the same server-backed stream.
  const { status, events } = useIncidentStreamContext();
  const latestProposalEvent = [...events].reverse().find((event) => {
    if (event.type !== "action_proposed") return false;
    const payload = event.payload as Record<string, unknown>;
    return payload.workflowRunId === incident.workflowRunId;
  });
  const payload = latestProposalEvent?.payload as
  | Record<string, unknown>
  | undefined;

  const proposalId = payload?.proposalId;
  const action = payload?.action;
  const riskLevel = payload?.riskLevel;

  const proposal: ProposalView | null =
    typeof proposalId === "string" &&
    typeof action === "string" &&
    isProposalRiskLevel(riskLevel)
      ? {
          proposalId,
          action,
          riskLevel,
        }
      : null;

  // Strict UI-level RBAC evaluation. This completely fixes the Phase 3 bug 
  // where Engineers saw approval controls they couldn't use.
  const canApprove = role === "COMMANDER";
  const canMutateStatus = role === "COMMANDER" || role === "ENGINEER";

  return (
    <div className="space-y-6 rounded-md border border-neutral-800 p-4">
      <div>
        <h1 className="text-xl font-semibold text-neutral-100">{incident.title}</h1>
        <p className="mt-1 text-sm text-neutral-400">{incident.description}</p>
        <p className="mt-2 text-xs text-neutral-500">
          {incident.severity} · {status}
        </p>
      </div>

      {/* Only Commanders see the actual approval controls */}
      {canApprove && status === "AWAITING_APPROVAL" && proposal && (
        <ApprovalControls incidentId={incident.id} orgId={orgId} proposal={proposal} />
      )}
      {canApprove && status === "AWAITING_APPROVAL" && !proposal && (
        <p role="alert" className="rounded-md border border-red-900 bg-red-950/30 p-3 text-xs text-red-300">
          This approval has no verifiable proposal identity. Refresh the incident and restart the workflow before deciding.
        </p>
      )}

      {/* Status transition controls (self-hides if no transitions are available) */}
      {canMutateStatus && status !== "AWAITING_APPROVAL" && (
        <StatusControls incidentId={incident.id} orgId={orgId} currentStatus={status} />
      )}

      {/* Fallback UI for Engineers/Observers waiting on a Commander */}
      {!canApprove && status === "AWAITING_APPROVAL" && (
        <p className="rounded-md border border-neutral-800 bg-neutral-900/50 p-3 text-xs text-neutral-400">
          Agent has proposed an action — waiting on a Commander to approve or reject.
        </p>
      )}
    </div>
  );
}