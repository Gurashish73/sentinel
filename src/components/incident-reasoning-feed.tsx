"use client";

import { useIncidentStreamContext } from "@/components/incident-stream-provider";

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
  injection_suspected: "⚠ Possible prompt injection",
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
          // Hide internal system markers from the UI
          .filter((e) => e.type !== "workflow_finished")
          .map((event) => {
            const payload = (event.payload ?? {}) as Record<string, unknown>;
            const isInjectionFlag = event.type === "injection_suspected";
            
            return (
              <li
                key={event.id}
                className={`rounded-md p-2 text-xs ${
                  isInjectionFlag
                    ? "border border-amber-700/60 bg-amber-950/30"
                    : "bg-neutral-900/50"
                }`}
              >
                <div className="flex items-center justify-between text-neutral-400">
                  <span className={`font-mono ${isInjectionFlag ? "text-amber-400" : ""}`}>
                    {EVENT_LABELS[event.type] ?? event.type}
                  </span>
                  <span>{new Date(event.createdAt).toLocaleTimeString()}</span>
                </div>

                {/* Injection tripwire: non-blocking heuristic flag for Commander review. */}
                {isInjectionFlag && typeof payload.source === "string" && (
                  <p className="mt-1 text-amber-400">
                    Suspicious instruction-like text detected in: {payload.source}.
                    The agent kept running, but review the resulting proposal
                    carefully before approving.
                  </p>
                )}

                {/* Dynamic text payloads (thoughts, errors) */}
                {typeof payload.text === "string" && (
                  <p className="mt-1 text-neutral-300">{payload.text}</p>
                )}

                {/* Dynamic proposed action payloads */}
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