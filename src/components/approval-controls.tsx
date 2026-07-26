"use client";

import { useTransition, useState } from "react";
import { respondToProposedAction } from "@/actions/agent";

export function ApprovalControls({ incidentId, orgId }: { incidentId: string; orgId: string }) {
  const [isPending, startTransition] = useTransition();
  
  // Stopgap: Prevents buttons from flashing back while the workflow asynchronously 
  // finishes in the background. Full fix comes in Phase 4 (live updates).
  const [hasResponded, setHasResponded] = useState<"approved" | "rejected" | null>(null);

  if (hasResponded) {
    return (
      <div className="rounded-md border border-neutral-800 bg-neutral-900/50 p-3 text-xs text-neutral-400">
        {hasResponded === "approved" ? "Approved" : "Rejected"} — waiting for the agent to finish executing.
        Refresh in a moment to see the final status.
      </div>
    );
  }

  return (
    <div className="flex gap-2 rounded-md border border-amber-800 bg-amber-950/30 p-3">
      <span className="mr-auto self-center text-xs text-amber-300">
        Agent has proposed an action — awaiting approval.
      </span>
      <button
        disabled={isPending}
        onClick={() => {
          setHasResponded("approved");
          startTransition(() => respondToProposedAction(incidentId, orgId, true));
        }}
        className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-emerald-50 hover:bg-emerald-600 disabled:opacity-50"
      >
        {isPending ? "Submitting…" : "Approve"}
      </button>
      <button
        disabled={isPending}
        onClick={() => {
          setHasResponded("rejected");
          startTransition(() => respondToProposedAction(incidentId, orgId, false));
        }}
        className="rounded-md bg-red-800 px-3 py-1.5 text-xs font-medium text-red-50 hover:bg-red-700 disabled:opacity-50"
      >
        {isPending ? "Submitting…" : "Reject"}
      </button>
    </div>
  );
}