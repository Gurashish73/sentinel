"use client";

import { useIncidentStreamContext } from "@/components/incident-stream-provider";

// Dictionary for clean UI labels
const EVENT_LABELS: Record<string, string> = {
  incident_created: "Incident created",
  alert_received: "Alert received",
  incident_status_changed: "Status changed",
  incident_resolved: "Resolved",
  thought: "Agent reasoning",
  tool_call: "Tool call",
  tool_result: "Tool result",
  action_proposed: "Action proposed",
  action_approved: "Approved",
  action_rejected: "Rejected",
  action_timed_out: "Timed out",
  action_executed: "Action executed",
  workflow_trigger_failed: "Failed to start",
};

export function IncidentReasoningFeed() {
  const { events, isDone, isErrored } = useIncidentStreamContext();

  return (
    <div className="space-y-3 rounded-md border border-neutral-800 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-300">Agent reasoning</h2>
        <span className="text-xs text-neutral-500">
          {isErrored ? "Disconnected" : isDone ? "Finished" : "Live"}
        </span>
      </div>

      <ul className="space-y-2">
        {events
          // Filter out internal system markers so they don't clutter the UI
          .filter((e) => e.type !== "workflow_finished") 
          .map((event) => {
            const payload = (event.payload ?? {}) as Record<string, unknown>;
            return (
              <li key={event.id} className="rounded-md bg-neutral-900/50 p-2 text-xs">
                <div className="flex items-center justify-between text-neutral-400">
                  <span className="font-mono">{EVENT_LABELS[event.type] ?? event.type}</span>
                  <span>{new Date(event.createdAt).toLocaleTimeString()}</span>
                </div>
                
                {/* Dynamically render text payloads (thoughts, errors) */}
                {typeof payload.text === "string" && (
                  <p className="mt-1 text-neutral-300">{payload.text}</p>
                )}
                
                {/* Dynamically render proposed action payloads */}
                {typeof payload.action === "string" && (
                  <p className="mt-1 text-neutral-300">
                    {payload.action}
                    {typeof payload.riskLevel === "string" && (
                      <span className="ml-2 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase text-neutral-400">
                        {payload.riskLevel} risk
                      </span>
                    )}
                  </p>
                )}
              </li>
            );
          })}
        {events.length === 0 && <li className="text-xs text-neutral-600">No agent activity yet.</li>}
      </ul>
    </div>
  );
}