# Phase 3 — Durable Agent Orchestration

**Checklist topics covered:** 16 (Advanced/AI features) · 18 (Edge Cases & Pitfalls, continued)

**Goal:** Every new incident automatically kicks off a Triage → Diagnosis → Remediation pipeline that reasons with a real LLM, proposes an action, and then **pauses — durably, for real, across serverless invocations** — until a Commander approves or rejects it. Nothing executes without a human in the loop.

This is the phase where the "will Vercel's timeout kill this" concern is permanently resolved. Instead of running the whole chain inside one request handler (which would blow past a function's duration limit), each stage becomes a separate **Upstash Workflow step**. Every step is its own serverless invocation with its own fresh time budget. Once a step succeeds, Upstash memoizes its result — a retry replays the earlier steps' outputs instead of re-executing them, preventing duplicate billing and duplicate event emissions.

---

## 0. Dependencies and Environment Variables

Install the Upstash Workflow and OpenAI SDK packages. (Implementation note: the agent stages run against GitHub Models — free via the GitHub Student Developer Pack — rather than a paid provider directly. This still uses the standard `openai` SDK, just pointed at Azure's inference endpoint and authenticated with a GitHub token instead of a standard OpenAI key, so no code shape changes, only the client configuration.)

In your environment configuration, transition the QStash and GitHub Models keys from optional to strictly required. An agent platform with a silently missing API key isn't a smaller version of the product; it's a broken one.

**Local dev note:** QStash needs to call your workflow route back over the public internet (`localhost:3000` isn't reachable from Upstash's servers). For end-to-end testing, either tunnel with `ngrok`/`cloudflared`, or test against a Vercel preview deployment.

**Free-tier note:** GitHub Models' free tier rate-limits per model per minute (observed: 2 requests/60s on `gpt-5-mini`). A 3-step pipeline (triage, diagnosis, remediation) can burn through that limit within itself, so expect noticeably longer end-to-end runs locally than the same pipeline would take on a paid tier — this is an infrastructure ceiling, not a bug in the orchestration.

---

## 1. Schema Addition

Add a single column (`workflowRunId`) to the `Incident` model. This allows the approval action to know exactly which paused workflow run to notify when a human makes a decision. Generate and apply the corresponding database migration.

---

## 2. Shared Event-Emission Helper

Every agent stage writes to the `Event` table constantly. Create a centralized helper (`src/lib/emit-agent-event.ts`) instead of repeating the database creation logic across multiple files. This maintains the strict type discipline established in Phase 1. Ensure the `AgentEvent` union type is updated to accommodate new workflow states, such as timeouts.

This helper is also the right place to invalidate the incident cache after every write — not `updateTag`, since everything here runs from the workflow's Route Handler rather than a Server Action, and `updateTag` can only be called from a Server Action. Use `revalidateTag(tag, { expire: 0 })` instead: the Route Handler equivalent for immediate invalidation, which is what Next's own docs recommend specifically for external callers (like QStash) needing fresh data right away. Centralizing this in the helper means every agent event write invalidates the cache automatically, instead of relying on each call site to remember to do it.

---

## 3. The Mock Tool

Since no real observability integration exists yet, create a clearly labeled mock tool (`src/agents/tools.ts`) that the Diagnosis agent can call. It should return fabricated but plausible log lines so the agent has something to reason over. This can be swapped for a real provider (Datadog, CloudWatch, etc.) later without touching the agent logic.

---

## 4. The Agent Stages (Triage, Diagnosis, Remediation)

Create isolated async functions for each stage (`src/agents/`). These files should know nothing about Upstash; they just take an incident and return a decision. Keeping them framework-agnostic allows for pure unit testing.

* **Triage:** Prompts the LLM to decide whether to INVESTIGATE or SKIP an incident based on severity and description.
* **Diagnosis:** Calls the mock log tool and passes the organization's runbook content directly in the prompt as context. (No vector search yet — plain text-in-context works fine at this scale).
* **Remediation:** Returns a structured JSON proposal and sets the incident status to awaiting approval. **Be explicit that remediation is simulated.** It should log what it *would* do without actually touching real infrastructure.

---

## 5. The Workflow Route

Replace the Phase 0 endpoint stub (`src/app/api/workflow/agent/route.ts`) with the Upstash serve handler. This route orchestrates the payload sequentially through the triage, diagnosis, and remediation functions. It must utilize Upstash's durable pause feature to halt execution entirely until a human approval event is received or a timeout occurs.

---

## 6. Wiring the Trigger into Ingestion

Every new incident should start its investigation automatically. Update the alert ingestion logic (`src/lib/ingest-alert.ts`) to trigger the Upstash workflow **after** the database transaction commits successfully.

*Architectural Rule:* Never place the network call to QStash inside the database transaction. Mixing HTTP calls with database transactions holds connections and row locks open unnecessarily and cannot be safely rolled back by the ORM if the network fails.

---

## 7. The Approval Actions

Create a secure Server Action (`src/actions/agent.ts`) to handle Commander responses. This action must re-verify the "COMMANDER" role dynamically, fetch the `workflowRunId`, log the approval/rejection event to the timeline, and notify the Upstash workflow client to resume the paused orchestration.

Know the limits of this action before wiring the UI to it: `notify()` only delivers the decision to the paused workflow — it does not wait for the workflow to actually wake up and finish executing. The real state change (e.g. flipping the incident to `RESOLVED`) happens later, asynchronously, once the workflow resumes. Calling `updateTag` immediately after `notify()` refreshes the UI with the true state *at that moment*, which may still legitimately be `AWAITING_APPROVAL` for several seconds or longer — this isn't a bug, it's the honest gap that Phase 4's live updates exist to close. See section 8 for the stopgap.

---

## 8. UI Integration

Build a Client Component (`src/components/approval-controls.tsx`) shown on the incident detail page only when the incident is awaiting approval and the user has the correct role. The existing event timeline from Phase 1 will automatically render the agent's reasoning (`thought`, `tool_call`, `action_proposed`) chronologically as the workflow progresses.

Stopgap for the gap noted in section 7: once a Commander clicks Approve or Reject, track that locally in the component and never show the buttons again for that render, replacing them with a "waiting for the agent to finish executing" message. This doesn't solve the underlying lack of live updates, but it stops the buttons from confusingly reappearing while the workflow is still catching up.

---

## Definition of Done for Phase 3

* [x] Triggering `simulateAlert` (Phase 2's button) results in a new incident that visibly moves from OPEN → INVESTIGATING within seconds.
* [x] Refreshing the incident detail page shows `thought`, `tool_call`, and `action_proposed` events appearing in the timeline as the workflow progresses.
* [x] The incident sits in `AWAITING_APPROVAL` and does **not** resolve itself — confirm nothing executes without the approval action being called.
* [x] Clicking Approve resolves the incident and writes an `action_executed` event describing a simulated action.
* [x] Clicking Reject returns the incident to `OPEN` without executing anything.
* [x] Killing the dev server mid-workflow and restarting it doesn't re-trigger already-completed steps when the workflow resumes.
* [x] A non-Commander calling `respondToProposedAction` directly (not through the UI) is rejected by `requireRole`, not just hidden by the missing button.
