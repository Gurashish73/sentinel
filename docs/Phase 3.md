# Phase 3: Durable Agent Orchestration

## Overview

Phase 3 transforms Sentinel from a traditional incident management application into an autonomous incident response platform.

Instead of requiring engineers to manually investigate every new alert, each incident now automatically enters a durable AI workflow. The workflow triages the alert, performs a diagnosis using available operational context, proposes a remediation, and then pauses indefinitely until a Commander explicitly approves or rejects the action.

Unlike conventional background jobs, the orchestration is designed to survive process crashes, serverless execution limits, transient infrastructure failures, duplicate webhook deliveries, and delayed human responses.

Rather than executing inside a single long-running request, every stage runs as an independent Upstash Workflow step. Each step executes in its own serverless invocation with automatic retry and memoization, allowing the workflow to resume from its last successful checkpoint instead of restarting from the beginning.

Nothing in this phase executes infrastructure changes automatically. Every remediation proposal remains blocked behind a durable human approval gate.

---

## Developer Notes & Architecture Decisions

### Workflow Foundation

#### 1. Durable Workflow Foundation

Instead of implementing the agent pipeline inside a single Route Handler, Sentinel delegates orchestration to Upstash Workflow.

```
src/app/api/workflow/agent/route.ts
```

Each workflow stage executes independently:

- load incident
- triage
- diagnosis
- remediation proposal
- human approval
- execution (or rejection)

Every completed step is checkpointed by Upstash.

If the process crashes, a deployment occurs, or a serverless invocation expires, execution resumes from the latest completed step instead of repeating previously successful work.

This architecture also avoids serverless timeout limitations because each workflow step receives a fresh execution budget.

---

#### 2. Workflow Identification

Each incident stores the durable workflow instance responsible for processing it.

```
Incident.workflowRunId
```

The workflow run ID becomes the permanent link between:

- the Incident record
- the paused Upstash Workflow
- the eventual Commander approval

When a Commander responds, the application doesn't search for running workflows.

Instead, it resumes the exact paused workflow using the stored `workflowRunId`.

---

#### 3. Structured Agent Event Protocol

Every stage of the workflow writes immutable events into the shared Event Store.

```
src/lib/event.ts
src/lib/emit-agent-event.ts
```

Rather than allowing each workflow step to construct arbitrary payloads, Phase 3 introduces a typed `AgentEvent` protocol shared across the entire application.

The protocol defines events such as:

- alert_received
- thought
- tool_call
- tool_result
- action_proposed
- action_approved
- action_rejected
- action_executed
- workflow_finished
- workflow_trigger_failed

Because every workflow stage writes through the shared `emitAgentEvent()` helper:

- event persistence is centralized
- cache invalidation happens automatically
- every event follows the same schema
- later phases (such as Phase 4's SSE stream) can consume the exact same event model without additional transformation

The helper also immediately invalidates the organization's incident cache after every event write using:

```ts
revalidateTag(tag, { expire: 0 })
```

Since workflow execution occurs inside Route Handlers rather than Server Actions, this is the correct invalidation mechanism.

---

### Agent Pipeline

#### 4. Agent Isolation

Each AI stage is implemented as an independent module.

```
src/agents/

├── triage.ts
├── diagnosis.ts
├── remediation.ts
└── tools.ts
```

These modules intentionally know nothing about:

- Upstash Workflow
- Route Handlers
- Server Actions
- React
- UI rendering

Instead, each agent receives structured inputs and returns structured outputs.

Keeping the agents framework-independent makes them:

- independently testable
- reusable by future workflows
- easier to replace without affecting orchestration

The workflow route remains responsible only for sequencing the stages together.

---

#### 5. AI Client Configuration

All workflow stages share a centralized AI client.

```
src/lib/ai-client.ts
```

Rather than instantiating a new SDK client inside every agent, Phase 3 creates a single reusable OpenAI-compatible client configured for Google's Gemini endpoint.

The application uses:

- OpenAI SDK
- Gemini OpenAI-compatible endpoint
- shared AGENT_MODEL configuration
- zero automatic SDK retries

Disabling SDK retries intentionally leaves retry responsibility to Upstash Workflow, preventing nested retry loops where both the SDK and workflow infrastructure attempt to recover the same failure independently.

---

#### 6. Mock Tool Abstraction

Before integrating real observability providers, the Diagnosis agent interacts with a mock tool abstraction.

```
src/agents/tools.ts
```

The tool returns fabricated but realistic infrastructure log lines such as:

- connection pool exhaustion
- query queue growth
- timeout acquisition failures

Although simulated, the abstraction mirrors the interface of a real log provider.

This allows future integrations (Datadog, CloudWatch, Grafana, Elasticsearch, etc.) to replace the implementation without modifying any Diagnosis agent logic.

The Diagnosis agent remains concerned only with consuming log data, not with how that data is retrieved.

---

#### 7. Triage Agent

The Triage agent determines whether an incoming incident should proceed through the investigation pipeline.

```
src/agents/triage.ts
```

Rather than hardcoding severity rules into the application, the incident is evaluated by the configured language model using its title, severity, and description.

The model produces one of two decisions:

- `INVESTIGATE`
- `SKIP`

The returned decision is intentionally minimal.

Instead of exposing the model's raw response directly to users, the workflow records a structured reasoning event explaining why the incident will either continue through the pipeline or be skipped.

This reasoning becomes part of the immutable event timeline alongside every later workflow decision.

---

#### 8. Diagnosis Agent

Once triage approves an investigation, the Diagnosis agent attempts to identify the likely root cause.

```
src/agents/diagnosis.ts
```

The Diagnosis stage combines two sources of operational context.

First, it calls the mock log provider:

```
fetchRecentLogs()
```

The tool interaction itself is recorded in the Event Store.

Three separate events are emitted:

- tool_call
- tool_result
- thought

This separation allows later phases to distinguish an agent's reasoning from the external tools it consulted.

After retrieving the logs, the agent also loads the organization's runbooks directly from the database.

Rather than implementing vector retrieval immediately, the runbooks are concatenated into plain prompt context.

This deliberately postpones semantic search until Phase 5 while still allowing the agent to reason over organizational documentation today.

The Diagnosis stage returns a concise natural-language summary describing:

- the likely root cause
- whether an existing runbook appears relevant

---

#### 9. Remediation Agent

The final AI stage proposes a single remediation action.

```
src/agents/remediation.ts
```

The model is instructed to return structured JSON instead of free-form text.

The expected schema is:

```json
{
  "action": "...",
  "riskLevel": "low | medium | high"
}
```

The response is parsed defensively before reaching the application.

The implementation:

- extracts the JSON payload
- parses it safely
- normalizes risk level casing
- validates the structure with Zod

Malformed responses never reach the UI.

Instead, the workflow records a reasoning event explaining that no valid remediation proposal could be produced, allowing the incident to remain under manual investigation.

When validation succeeds:

- an `action_proposed` event is written
- the proposal is stored in the immutable event timeline
- the incident status transitions to `AWAITING_APPROVAL`

No infrastructure changes occur at this stage.

The proposed action remains entirely simulated until a Commander explicitly approves it.

---

### Workflow Orchestration & Reliability

#### 10. Durable Workflow Orchestration

The workflow route coordinates every stage of the investigation.

```ts
src/app/api/workflow/agent/route.ts
```

Rather than embedding orchestration logic inside the individual agents, each stage is executed sequentially through Upstash Workflow.

The workflow executes the following steps:

1. Load the incident.
2. Run triage.
3. Skip immediately if investigation is unnecessary.
4. Run diagnosis.
5. Generate a remediation proposal.
6. Pause indefinitely awaiting human approval.
7. Resume when notified by a Commander.
8. Record the final outcome.
9. Emit a terminal workflow event.

Each stage executes through:

```ts
context.run(...)
```

This gives every step durable checkpointing and automatic replay behavior.

Previously completed stages are memoized by Upstash and are never executed twice during retries.

---

#### 11. Durable Human Approval Gate

Once a remediation proposal exists, the workflow deliberately pauses.

```ts
context.waitForEvent(...)
```

The pause is durable rather than process-local.

No server process remains running while waiting.

Instead, the workflow state is stored by Upstash until one of two events occurs:

- a Commander responds
- the configured timeout expires

This allows approval to occur minutes, hours, or even days later without consuming compute resources.

Once resumed, execution continues from the next workflow step instead of restarting from the beginning.

---

#### 12. Timeout Handling

Human approval is not assumed to happen indefinitely.

The workflow therefore configures a timeout while waiting for approval.

If the timeout expires:

- an `action_timed_out` event is written
- the incident returns to `OPEN`
- a terminal `workflow_finished` event is emitted

This guarantees every workflow reaches a deterministic end state regardless of whether a human responds.

---

#### 13. Workflow Completion

Every exit path through the workflow emits a terminal lifecycle event.

```
workflow_finished
```

Possible completion reasons include:

- resolved
- rejected
- skipped
- timed_out

Rather than forcing downstream consumers to infer completion from business status changes, this dedicated event explicitly communicates that the workflow has permanently stopped processing the incident.

Phase 4 later uses this event to terminate live SSE connections cleanly.

---

#### 14. Self-Healing Workflow Trigger

Incident creation and workflow execution intentionally remain separate responsibilities.

```
src/lib/ingest-alert.ts
```

The database transaction completes first.

Only after the transaction commits successfully does Sentinel attempt to trigger the Upstash Workflow.

This avoids holding database locks open while waiting on external network calls.

If the workflow trigger fails temporarily, Sentinel retries several times using linear backoff.

If every retry still fails:

- the incident remains safely persisted
- a `workflow_trigger_failed` event is written
- operators retain full visibility into the failure

This prevents successful incident ingestion from being lost because of a transient infrastructure outage.

---

#### 15. Duplicate Webhook Recovery

Webhook providers commonly retry requests after network failures.

Instead of treating duplicate deliveries as errors, Sentinel uses them as a recovery mechanism.

If an incoming webhook collides with an existing external ID:

1. the existing incident is located
2. the workflow state is inspected
3. if no workflow has ever started, Sentinel automatically triggers one

This creates a self-healing path for the rare situation where:

- the database transaction committed successfully
- the workflow trigger failed afterward

Rather than leaving the incident permanently stranded, the next duplicate webhook transparently repairs the system.

This recovery path exists entirely without operator intervention.

---

### Human Approval & UI Integration

#### 16. Commander Approval Action

Human approval is handled through a dedicated Server Action.

```
src/actions/agent.ts
```

Before notifying the workflow, the action:

- dynamically verifies Commander authorization
- verifies organization membership
- confirms the incident still belongs to the organization
- prevents duplicate voting by confirming the incident remains in `AWAITING_APPROVAL`
- records an approval or rejection event

Only after these checks succeed does the action notify the paused workflow.

Importantly, calling:

```ts
workflowClient.notify(...)
```

does **not** wait for the workflow to resume and complete.

It merely delivers the approval decision.

The actual execution, status transition, and event generation occur later when the workflow wakes and continues processing.

This asynchronous gap becomes the primary UX challenge addressed in Phase 4.

---

#### 17. Temporary UI Integration

Phase 3 introduces the first approval interface.

```
src/components/approval-controls.tsx
```

Without live streaming yet available, the UI cannot immediately observe the workflow resuming after approval.

To avoid duplicate submissions, the component temporarily hides the approval buttons immediately after a Commander responds, replacing them with a neutral waiting message.

This workaround intentionally acknowledges the asynchronous nature of durable workflows without pretending the incident has already resolved.

Phase 4 later replaces this temporary solution with live Server-Sent Events that reconcile the interface directly against the workflow's true execution state.

---

# Implementation Checklist

## Durable Workflow Infrastructure

```
src/app/api/workflow/agent/route.ts
src/lib/ai-client.ts
```

**Implemented:**

- Upstash Workflow orchestration
- durable workflow checkpoints
- memoized workflow steps
- independent serverless execution
- shared AI client configuration
- OpenAI-compatible Gemini integration

---

## Agent Pipeline

```
src/agents/

├── triage.ts
├── diagnosis.ts
├── remediation.ts
└── tools.ts
```

**Implemented:**

- LLM-powered triage
- mock observability tool
- runbook-assisted diagnosis
- structured remediation proposals
- Zod validation
- simulated infrastructure actions

---

## Event Infrastructure

```
src/lib/event.ts
src/lib/emit-agent-event.ts
```

**Implemented:**

- typed AgentEvent protocol
- centralized event persistence
- automatic cache invalidation
- immutable workflow timeline
- workflow lifecycle events
- trigger failure reporting

---

## Workflow Triggering

```
src/lib/ingest-alert.ts
```

**Implemented:**

- post-transaction workflow triggering
- retry with linear backoff
- self-healing duplicate webhook recovery
- workflowRunId persistence
- graceful trigger failure handling

---

## Human Approval

```
src/actions/agent.ts
```

**Implemented:**

- Commander-only approval
- workflow notification
- duplicate vote prevention
- approval/rejection event logging
- dynamic RBAC enforcement
- asynchronous workflow resumption

---

## Definition of Done

- [x] Creating an incident automatically triggers a durable Upstash Workflow after the database transaction commits.
- [x] Every workflow stage executes independently and survives serverless invocation boundaries.
- [x] Triage determines whether an incident should be investigated or skipped.
- [x] Diagnosis retrieves mock infrastructure logs and organization runbooks before generating a reasoning summary.
- [x] Remediation produces a structured proposal validated with Zod before reaching the UI.
- [x] Incidents transition to `AWAITING_APPROVAL` without executing infrastructure changes automatically.
- [x] Commander approval resumes the paused workflow using the stored `workflowRunId`.
- [x] Rejecting a proposal safely returns the incident to `OPEN`.
- [x] Approval timeouts return incidents to `OPEN` and emit explicit timeout events.
- [x] Every workflow completion path emits a terminal `workflow_finished` event.
- [x] Duplicate webhook deliveries recover partially completed ingestion when necessary.
- [x] Workflow trigger failures are surfaced through immutable timeline events rather than silently failing.
- [x] Agent reasoning, tool calls, remediation proposals, approvals, and execution events are recorded in the immutable Event Store.
- [x] Workflow execution remains completely simulated—no remediation step modifies real infrastructure.

---

## Closing Notes

Phase 3 establishes Sentinel's core execution engine.

At the end of this phase, the platform is capable of accepting external alerts, orchestrating a durable multi-stage AI investigation, reasoning over operational context, proposing a remediation, and pausing indefinitely until a human explicitly authorizes the action.

The workflow is resilient to duplicate webhook deliveries, transient infrastructure failures, serverless execution limits, and delayed human responses, while maintaining a complete immutable audit trail of every decision made throughout the incident lifecycle.

The remaining limitation is user experience rather than orchestration. Although every workflow event is persisted immediately, operators must still refresh the interface to observe new agent reasoning and status transitions.

Phase 4 addresses this by introducing a polling-backed Server-Sent Events pipeline, allowing incident timelines, reasoning feeds, approval reconciliation, and workflow status to stream live directly from the immutable Event Store.
