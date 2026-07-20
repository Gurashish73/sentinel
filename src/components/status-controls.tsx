"use client";

import { useTransition } from "react";
import { updateIncidentStatus } from "@/actions/incidents";
import type { IncidentStatus } from "@prisma/client";

/**
 * STATUS CONTROLS (Client Component)
 * 
 * Renders the interactive buttons for transitioning an incident through its lifecycle.
 * Because this is a direct button click (not a form submission), we use React's 
 * `useTransition` to seamlessly execute the Server Action without blocking the UI thread.
 */

// Finite State Machine (FSM) dictionary.
// Strictly defines which status transitions are mathematically possible.
const NEXT_STATUS: Record<IncidentStatus, IncidentStatus[]> = {
  OPEN: ["INVESTIGATING"],
  INVESTIGATING: ["AWAITING_APPROVAL", "RESOLVED"],
  AWAITING_APPROVAL: ["RESOLVED"],
  RESOLVED: [], // Terminal state
};

export function StatusControls({
  incidentId,
  orgId,
  currentStatus,
}: {
  incidentId: string;
  orgId: string;
  currentStatus: IncidentStatus;
}) {
  // Keeps the UI responsive while the Server Action executes in the background
  const [isPending, startTransition] = useTransition();
  
  const options = NEXT_STATUS[currentStatus];

  // If there are no valid next steps (e.g., the incident is RESOLVED), hide the controls entirely.
  if (options.length === 0) return null;

  return (
    <div className="flex gap-2">
      {options.map((status) => (
        <button
          key={status}
          disabled={isPending}
          onClick={() =>
            startTransition(async () => {
              // The backend (actions/incidents.ts) enforces the actual RBAC,
              // verifying if the user has the authority to make this specific transition.
              await updateIncidentStatus({ incidentId, orgId, status });
            })
          }
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-50 transition-colors"
        >
          {isPending ? "Updating…" : `Mark ${status.replace("_", " ")}`}
        </button>
      ))}
    </div>
  );
}