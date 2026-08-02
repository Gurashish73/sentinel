"use client";

import { useTransition, useState, useEffect } from "react";
import { respondToProposedAction } from "@/actions/agent";
import { useIncidentStreamContext } from "@/components/incident-stream-provider";

export function ApprovalControls({ incidentId, orgId }: { incidentId: string; orgId: string }) {
  // Consume the live status directly from the SSE provider
  const { status } = useIncidentStreamContext();

  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Bridges the gap between the server action finishing (HTTP resolves) 
  // and the background Upstash workflow actually updating the database via SSE.
  const [isAwaitingStream, setIsAwaitingStream] = useState(false);

  // Safely release the lock the exact millisecond the SSE stream reports the true status.
  useEffect(() => {
    if (status !== "AWAITING_APPROVAL") {
      setIsAwaitingStream(false);
    }
  }, [status]);

  // 1. Terminal State: Driven strictly by the server truth (SSE). Never guessed.
  if (status !== "AWAITING_APPROVAL") {
    return (
      <div className="rounded-md border border-neutral-800 bg-neutral-900/50 p-3 text-xs text-neutral-400">
        {status === "RESOLVED" ? "Resolved." : "Returned to OPEN — no longer awaiting approval."}
      </div>
    );
  }

  // 2. Processing State: The Commander has clicked, but the background workflow is still running.
  if (isAwaitingStream) {
    return (
      <div className="rounded-md border border-neutral-800 bg-neutral-900/50 p-3 text-xs text-neutral-400">
        Decision submitted — waiting for the agent to act on it.
      </div>
    );
  }

  // 3. Interactive State: Waiting for Commander input.
  function respond(approved: boolean) {
    setError(null);
    startTransition(async () => {
      setIsAwaitingStream(true);
      try {
        await respondToProposedAction(incidentId, orgId, approved);
      } catch (err) {
        // If the action fails at the network layer, release the lock so the user can try again.
        setIsAwaitingStream(false);
        setError(err instanceof Error ? err.message : "Something went wrong submitting your response.");
      }
    });
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