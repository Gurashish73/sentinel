"use client";

import { useTransition, useState } from "react";
import { respondToProposedAction } from "@/actions/agent";

export function ApprovalControls({ incidentId, orgId }: { incidentId: string; orgId: string }) {
  const [isPending, startTransition] = useTransition();
  
  // Stopgap: Prevents buttons from flashing back while the workflow asynchronously 
  // finishes in the background. Full fix comes in Phase 4 (live updates).
  const [hasResponded, setHasResponded] = useState<"approved" | "rejected" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function respond(approved: boolean) {
    setError(null);
    setHasResponded(approved ? "approved" : "rejected");
    
    startTransition(async () => {
      try {
        await respondToProposedAction(incidentId, orgId, approved);
      } catch (err) {
        // Revert optimistic state and surface the error to prevent permanent UI hangs
        // if the Server Action fails (e.g., double-vote guard, role demotion, network blip).
        setHasResponded(null);
        setError(err instanceof Error ? err.message : "Something went wrong submitting your response.");
      }
    });
  }

  if (hasResponded) {
    return (
      <div className="rounded-md border border-neutral-800 bg-neutral-900/50 p-3 text-xs text-neutral-400">
        {hasResponded === "approved" ? "Approved" : "Rejected"} — waiting for the agent to finish executing.
        Refresh in a moment to see the final status.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {error && (
        <p className="rounded-md border border-red-900 bg-red-950/40 p-2 text-xs text-red-300">{error}</p>
      )}
      <div className="flex gap-2 rounded-md border border-amber-800 bg-amber-950/30 p-3">
        <span className="mr-auto self-center text-xs text-amber-300">
          Agent has proposed an action — awaiting approval.
        </span>
        <button
          disabled={isPending}
          onClick={() => respond(true)}
          className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-emerald-50 hover:bg-emerald-600 disabled:opacity-50"
        >
          {isPending ? "Submitting…" : "Approve"}
        </button>
        <button
          disabled={isPending}
          onClick={() => respond(false)}
          className="rounded-md bg-red-800 px-3 py-1.5 text-xs font-medium text-red-50 hover:bg-red-700 disabled:opacity-50"
        >
          {isPending ? "Submitting…" : "Reject"}
        </button>
      </div>
    </div>
  );
}