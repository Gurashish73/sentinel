/**
 * The structured event protocol for agent activity and incident lifecycles.
 *
 * This is the type that Phase 3 (workflow steps) writes and Phase 4
 * (the SSE reasoning feed) reads. Nailing this down now, before either
 * side exists, is what turns "streaming structured agent thoughts" from
 * a research problem into a typed plumbing problem.
 *
 * Every event gets persisted as an `Event` row (see schema.prisma)
 * with `type` + `payload` mirroring this shape, so the immutable event store 
 * and the live feed are always describing the exact same facts.
 */
export type AgentEvent =
  // 1. Incident Lifecycle Events
  | { type: "incident_created"; actorId: string; ts: number }
  | { type: "alert_received"; source: string; payload: Record<string, unknown>; ts: number }
  | { type: "incident_status_changed"; actorId: string; from: string; to: string; ts: number }
  | { type: "incident_resolved"; actorId: string; ts: number }

  // 2. Agent Reasoning & RAG Events
  | { type: "thought"; text: string; ts: number }
  | { type: "tool_call"; tool: string; args: Record<string, unknown>; ts: number }
  | { type: "tool_result"; tool: string; result: unknown; ts: number }

  // 3. Human-in-the-Loop & Execution Events
  | {
      type: "action_proposed";
      action: string;
      riskLevel: "low" | "medium" | "high";
      ts: number;
    }
  | { type: "action_approved"; actorId: string; ts: number }
  | { type: "action_rejected"; actorId: string; ts: number }
  | { type: "action_timed_out"; ts: number }
  | { type: "action_executed"; action: string; result: unknown; ts: number }
  
  // 4. Orchestration Lifecycle Events (Phase 4)
  // Fired once, at every exit point of the workflow route, regardless of
  // business outcome. This gives the SSE route an unambiguous "the agent
  // is done touching this incident" signal that doesn't require inferring
  // completion from a specific business event.
  | { type: "workflow_finished"; reason: "resolved" | "rejected" | "timed_out" | "skipped"; ts: number }
  | { type: "workflow_trigger_failed"; reason: string; ts: number };
  
// Helper type to extract just the string literal union (e.g., "thought" | "tool_call" | ...)
// This prevents us from having to maintain a separate hardcoded array or enum.
export type AgentEventType = AgentEvent["type"];