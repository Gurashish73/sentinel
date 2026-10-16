"use client";

import { useTransition, useState, useEffect } from "react";
import { respondToProposedAction } from "@/actions/agent";
import { useIncidentStreamContext } from "@/components/incident-stream-provider";

export type ProposalView = {
  proposalId: string;
  action: string;
  riskLevel: "low" | "medium" | "high";
};

export function ApprovalControls({
  incidentId,
  orgId,
  proposal,
}: {
  incidentId: string;
  orgId: string;
  proposal: ProposalView;
}) {
  const { status } = useIncidentStreamContext();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [isAwaitingStream, setIsAwaitingStream] = useState(false);

  useEffect(() => {
    if (status !== "AWAITING_APPROVAL") {
      // This state intentionally mirrors the external SSE/server status.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsAwaitingStream(false);
    }
  }, [status]);

  if (status !== "AWAITING_APPROVAL") {
    return (
      <div className="rounded-md border border-neutral-800 bg-neutral-900/50 p-3 text-xs text-neutral-400">
        {status === "RESOLVED"
          ? "Resolved."
          : status === "ESCALATION_REQUIRED"
            ? "Approved action blocked by blast-radius protection. Manual operator review required."
            : "Returned to OPEN — no longer awaiting approval."}
      </div>
    );
  }

  if (isAwaitingStream) {
    return (
      <div className="rounded-md border border-neutral-800 bg-neutral-900/50 p-3 text-xs text-neutral-400">
        Decision submitted — waiting for the agent to act on it.
      </div>
    );
  }

  function respond(approved: boolean) {
    setError(null);
    startTransition(async () => {
      setIsAwaitingStream(true);
      try {
        const result = await respondToProposedAction(incidentId, orgId, proposal.proposalId, approved);
        if (!result.ok) {
          setIsAwaitingStream(false);
          setError(result.error);
        }
      } catch {
        setIsAwaitingStream(false);
        setError("Something went wrong submitting your response. Please try again.");
      }
    });
  }

  return (
    <div className="space-y-2">
      <div className="rounded-md border border-amber-800 bg-amber-950/30 p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-300">Proposed remediation</p>
        <p className="mt-1 text-sm text-neutral-100">{proposal.action}</p>
        <p className="mt-1 text-xs text-neutral-400">Risk: {proposal.riskLevel}</p>
        <p className="mt-2 text-xs text-amber-300">Approve only this proposal. A different proposal requires a new decision.</p>
      </div>

      {error && (
        <p role="alert" className="rounded-md border border-red-900 bg-red-950/40 p-2 text-xs text-red-300">
          {error}
        </p>
      )}
      <div className="flex gap-2 rounded-md border border-amber-800 bg-amber-950/30 p-3">
        <span className="mr-auto self-center text-xs text-amber-300">
          Human approval required before execution.
        </span>
        <button
          disabled={isPending}
          onClick={() => respond(true)}
          className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-emerald-50 hover:bg-emerald-600 disabled:opacity-50"
        >
          Approve
        </button>
        <button
          disabled={isPending}
          onClick={() => respond(false)}
          className="rounded-md bg-red-800 px-3 py-1.5 text-xs font-medium text-red-50 hover:bg-red-700 disabled:opacity-50"
        >
          Reject
        </button>
      </div>
    </div>
  );
}
