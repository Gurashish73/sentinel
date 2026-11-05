"use client";

import {
  ApprovalControls,
  type ProposalView,
} from "@/components/approval-controls";
import { retryIncidentInvestigation } from "@/actions/incidents";
import { useIncidentStreamContext } from "@/components/incident-stream-provider";
import { isRetryableWorkflowFinishEvent } from "@/lib/retry-eligibility";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
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
  incident: {
    id: string;
    title: string;
    description: string | null;
    severity: string;
    workflowRunId: string | null;
  };
  orgId: string;
  role: Role;
}) {
  // Live status and workflow identity come from the SSE provider.
  const {
    status,
    events,
    workflowRunId,
    restartStream,
  } = useIncidentStreamContext();

  const router = useRouter();

  const [isRetryPending, startRetryTransition] = useTransition();
  const [retryError, setRetryError] = useState<string | null>(null);

  // Match proposals against the live workflow run, not a potentially stale
  // server-rendered incident prop.
  const latestProposalEvent = [...events].reverse().find((event) => {
    if (event.type !== "action_proposed") return false;

    const payload = event.payload as Record<string, unknown>;

    return payload.workflowRunId === workflowRunId;
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

  // Only Commanders can approve or retry investigations.
  // The server independently enforces the same authorization.
  const canApprove = role === "COMMANDER";

  // Use the shared server/client retry eligibility rules.
  const hasRetryableFinish =
    Boolean(workflowRunId) &&
    events.some((event) =>
      isRetryableWorkflowFinishEvent(
        event,
        incident.id,
        workflowRunId,
      ),
    );

  const hasTriggerFailure =
    !workflowRunId &&
    events.some(
      (event) => event.type === "workflow_trigger_failed",
    );

  // OPEN incidents without a current workflow run can be recovered even
  // when the process crashed before recording workflow_trigger_failed.
  const canRetry =
    canApprove &&
    (
      (
        status === "OPEN" &&
        (!workflowRunId || hasRetryableFinish)
      ) ||
      (
        status === "ESCALATION_REQUIRED" &&
        hasRetryableFinish
      )
    );

  function retryInvestigation() {
    startRetryTransition(async () => {
      setRetryError(null);

      const result = await retryIncidentInvestigation({
        incidentId: incident.id,
        orgId,
      });

      if ("error" in result) {
        setRetryError(result.error);

        // Refresh status and reconnect after a failed or rolled-back attempt.
        restartStream();
        router.refresh();
        return;
      }

      restartStream();
      router.refresh();
    });
  }

  return (
    <div className="space-y-6 rounded-md border border-neutral-800 p-4">
      <div>
        <h1 className="text-xl font-semibold text-neutral-100">
          {incident.title}
        </h1>

        <p className="mt-1 text-sm text-neutral-400">
          {incident.description}
        </p>

        <p className="mt-2 text-xs text-neutral-500">
          {incident.severity} · {status}
        </p>
      </div>

      {/* Only Commanders see approval controls. */}
      {canApprove && status === "AWAITING_APPROVAL" && proposal && (
        <ApprovalControls
          incidentId={incident.id}
          orgId={orgId}
          proposal={proposal}
        />
      )}

      {canApprove && status === "AWAITING_APPROVAL" && !proposal && (
        <p
          role="alert"
          className="rounded-md border border-red-900 bg-red-950/30 p-3 text-xs text-red-300"
        >
          This approval has no verifiable proposal identity. Refresh the
          incident and restart the workflow before deciding.
        </p>
      )}

      {/* Retry controls are restricted to Commanders. */}
      {canRetry && (
        <div className="space-y-2">
          <button
            type="button"
            disabled={isRetryPending}
            onClick={retryInvestigation}
            className="rounded-md border border-amber-700 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-950/40 disabled:opacity-50 transition-colors"
          >
            {isRetryPending
              ? "Starting investigation…"
              : status === "ESCALATION_REQUIRED"
                ? "Review and retry investigation"
                : !workflowRunId || hasTriggerFailure
                  ? "Retry starting investigation"
                  : "Retry investigation"}
          </button>

          {retryError && (
            <p role="alert" className="text-xs text-red-300">
              {retryError}
            </p>
          )}
        </div>
      )}

      {/* Engineers and Observers wait for a Commander to decide. */}
      {!canApprove && status === "AWAITING_APPROVAL" && (
        <p className="rounded-md border border-neutral-800 bg-neutral-900/50 p-3 text-xs text-neutral-400">
          Agent has proposed an action — waiting on a Commander to
          approve or reject.
        </p>
      )}
    </div>
  );
}