"use client";

import { useIncidentStreamContext } from "@/components/incident-stream-provider";

// Expected payload shape for Phase 4.5/5 UI rendering.
// Future phases may replace this with shared event types.
type EventPayload = {
  source?: string;
  text?: string;
  action?: string;
  riskLevel?: string;
  runbookTitle?: string;
};

// Strict dictionary for proper brand capitalization
const SOURCE_NAMES: Record<string, string> = {
  github: "GitHub",
  sentry: "Sentry",
  synthetic: "Synthetic",
};

// Header fallback labels
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
  unretrieved_citation_suspected: "⚠ Unverified runbook citation",
};

// Centralized stage mapping for prompt injection tracking and taint propagation
const INJECTION_STAGE_COPY: Record<string, { label: string; detail: string }> = {
  incident_title_or_description: {
    label: "⚠ Possible prompt injection — flagged during triage",
    detail: "Suspicious instruction-like text detected in the incident title or description.",
  },
  incident_or_logs: {
    label: "⚠ Possible prompt injection — confirmed during diagnosis",
    detail: "Same suspicious pattern also found while scanning logs. Independently flagged at a second pipeline stage.",
  },
  incident_or_diagnosis: {
    label: "⚠ Possible prompt injection — carried into remediation",
    detail: "Suspicious pattern persisted from the diagnosis summary into the remediation proposal step.",
  },
};

// `retrieved_chunk:<chunkId>` is a dynamic source, so it needs a
// prefix match rather than an exact key in INJECTION_STAGE_COPY.
function resolveInjectionStage(source: string): { label: string; detail: string } {
  if (source.startsWith("retrieved_chunk:")) {
    const chunkId = source.split(":")[1] ?? source;
    return {
      label: "⚠ Possible prompt injection — found in a retrieved runbook chunk",
      detail: `Suspicious instruction-like text detected inside retrieved runbook chunk ${chunkId}. Independently flagged before reaching the model.`,
    };
  }
  return (
    INJECTION_STAGE_COPY[source] ?? {
      label: "⚠ Possible prompt injection detected",
      detail: `Suspicious instruction-like text detected in: ${source}.`,
    }
  );
}

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
            const payload = (event.payload ?? {}) as EventPayload;
            const isInjectionFlag = event.type === "injection_suspected";
            const isCitationFlag = event.type === "unretrieved_citation_suspected";
            const isFlagged = isInjectionFlag || isCitationFlag;

            // Determine header label dynamically
            let headerLabel = EVENT_LABELS[event.type] ?? event.type;
            let flagDetail = "";

            if (isInjectionFlag && typeof payload.source === "string") {
              const stage = resolveInjectionStage(payload.source);
              headerLabel = stage.label;
              flagDetail = stage.detail;
            } else if (isCitationFlag && typeof payload.runbookTitle === "string") {
              flagDetail = `The diagnosis mentions "${payload.runbookTitle}", but none of its chunks were actually retrieved for this incident. This may be a hallucinated citation — verify before trusting it.`;
            } else if (event.type === "alert_received" && typeof payload.source === "string") {
              // Apply proper branding capitalization
              headerLabel = `Alert received from ${SOURCE_NAMES[payload.source] ?? payload.source}`;
            }

            return (
              <li
                key={event.id}
                className={`rounded-md p-2 text-xs ${
                  isInjectionFlag
                    ? "border border-amber-700/60 bg-amber-950/30"
                    : isCitationFlag
                      ? "border border-sky-700/60 bg-sky-950/30"
                      : "bg-neutral-900/50"
                }`}
              >
                <div className="flex items-center justify-between text-neutral-400">
                  <span
                    className={`font-mono ${
                      isInjectionFlag ? "text-amber-400" : isCitationFlag ? "text-sky-400" : ""
                    }`}
                  >
                    {headerLabel}
                  </span>
                  <span>{new Date(event.createdAt).toLocaleTimeString()}</span>
                </div>

                {/* Tripwires: non-blocking heuristic flags for Commander review */}
                {isInjectionFlag && (
                  <p className="mt-1 text-amber-400/90">
                    {flagDetail} The agent kept running, but review the resulting proposal
                    carefully before approving.
                  </p>
                )}
                {isCitationFlag && <p className="mt-1 text-sky-300/90">{flagDetail}</p>}

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