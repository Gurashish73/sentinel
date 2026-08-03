"use client";

import { ApprovalControls } from "@/components/approval-controls";
import { StatusControls } from "@/components/status-controls";
import { useIncidentStreamContext } from "@/components/incident-stream-provider";
import type { Role } from "@prisma/client";

export function IncidentTimelinePanel({
  incident,
  orgId,
  role,
}: {
  incident: { id: string; title: string; description: string | null; severity: string };
  orgId: string;
  role: Role;
}) {
  // Pulls live status directly from the SSE stream
  const { status } = useIncidentStreamContext();
  
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
      {canApprove && status === "AWAITING_APPROVAL" && (
        <ApprovalControls incidentId={incident.id} orgId={orgId} />
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