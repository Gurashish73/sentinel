# Phase 6 — Hardening, Reliability & Polish

## Overview

Phase 6 adds layered security, resource controls, workflow reliability, database-backed lifecycle protections, and UI recovery behavior to Sentinel's public webhook ingestion and human-approved remediation workflow.

Earlier phases established the core trust boundaries:

- **Phase 1:** database-backed authorization and organization isolation.
- **Phase 2:** HMAC-authenticated webhook ingestion and idempotent event persistence.
- **Phase 3:** durable agent orchestration with mandatory Commander approval.
- **Phase 4.5:** agent-input hardening against prompt injection while preserving human control.
- **Phase 5:** organization-scoped retrieval with explicit trust boundaries.

Those controls do not, by themselves, constrain request volume, prevent repeated execution attempts, or guarantee that delayed workflow deliveries cannot take ownership of a newer attempt. Phase 6 addresses those additional risks without replacing the existing authorization and approval boundaries.

## Security Architecture and Runtime Boundaries

### 1. Defense-in-depth rate limiting

Rate limiting is enforced at multiple independent boundaries. Passing one limiter does not imply that a request is permitted by the next.

| Boundary | Scope | Limit | Window |
|---|---|---:|---|
| Public webhook | Client IP | 30 requests | 10 seconds |
| Webhook ingestion | Organization | 60 requests | 60 seconds |
| Commander approval | User | 10 actions | 60 seconds |
| Remediation execution | Organization | 10 executions | 1 hour |

Redis-backed state allows request budgets to be shared across application instances rather than maintained in process-local memory. Redis URL and token configuration are required by the runtime environment schema in `src/lib/env.ts`.

### 2. Webhook request ordering

Webhook ingestion follows this order:

```text
Incoming Webhook
       |
       v
IP Rate Limiter
       |
       v
Organization Lookup
       |
       v
HMAC Verification
       |
       v
Organization Rate Limiter
       |
       v
Payload Validation
       |
       v
Idempotent Ingestion
       |
       v
Incident / Event Persistence
```

The IP limiter runs before organization lookup so excessive traffic can be rejected before a database lookup. Requests that exceed the IP budget receive HTTP `429 Too Many Requests`.

The organization limiter runs only after the organization is resolved and the HMAC signature has been verified. Unsigned requests therefore do not consume the legitimate organization's ingestion budget. Requests that exceed the organization budget also receive HTTP `429`.

The existing ingestion pipeline remains responsible for payload validation, duplicate-delivery handling, and persistence. Rate limiting supplements those guarantees rather than replacing them.

### 3. Redis failure semantics

Different boundaries use different failure policies according to their risk:

- **Webhook ingestion:** fails closed if the required rate-limit operation cannot be completed.
- **Remediation execution:** fails closed if the execution budget cannot be established.
- **Commander approval:** an explicit rate-limit denial rejects the request, but a Redis infrastructure failure does not independently remove the human-approval path.

The approval path still requires database-backed Commander authorization, an incident in `AWAITING_APPROVAL`, and the existing stale/duplicate-state guards. During a Redis outage, approval may proceed without the additional rate-limit protection, but it does not bypass authorization or incident-state validation.

### 4. Client IP and proxy assumptions

`getClientIp()` uses the `x-forwarded-for` and `x-real-ip` headers. Those headers are trustworthy only when the deployment establishes a trusted proxy boundary.

The public reverse proxy must sanitize or overwrite forwarding headers. A self-hosted deployment that blindly trusts client-supplied forwarding headers can weaken IP-based limits because clients may manipulate the rate-limit key.

## Blast-Radius Control

### 5. Organization-level execution budget

The execution limiter allows **10 executions per organization per hour**. It is evaluated after the Commander has approved the proposal and immediately before the simulated execution step.

```text
Proposed Remediation
        |
        v
Commander Approval
        |
        v
Authorization and Approval-State Validation
        |
        v
Organization Execution Limiter
        |
        +--------------------------+
        |                          |
        v                          v
  Budget Allowed            Budget Exceeded
        |                          |
        v                          v
Execute Simulated           ESCALATION_REQUIRED
Remediation                         |
        |                           v
        v                    Record Escalation
 action_executed                    |
                                    v
                            workflow_finished
```

The budget is organization-scoped so multiple Commanders in one organization share the same limit. It is an execution control, not an approval mechanism: the proposed action must first pass the existing human approval workflow.

### 6. Explicit escalation on limit exhaustion

If the execution budget is exceeded, the blocked remediation is not executed. The workflow:

1. Does not emit `action_executed` for the blocked action.
2. Transitions the incident to `ESCALATION_REQUIRED`.
3. Records a `blast_radius_exceeded` event.
4. Emits a terminal `workflow_finished` event with reason `blast_radius_exceeded`.

This is an explicit operational outcome, not a claim that the remediation was executed or the incident resolved.

### 7. Durable workflow-step serialization

The blast-radius check runs inside an Upstash Workflow `context.run()` step. Its rate-limit result includes a `pending` Promise for background analytics writes. That Promise must not be included in the durable checkpoint result.

The workflow step returns only the serializable fields required by later workflow logic:

```ts
{
  success,
  limit,
  remaining,
  reset,
}
```

A regression test verifies that `pending` is excluded.

## Workflow, Approval, and Lifecycle Reliability

### 8. Workflow-event idempotency

Supported workflow events can use stable deduplication keys persisted through `Event.externalId`. The unique `(orgId, externalId)` constraint identifies repeated logical events. Repeated writes with the same stable key become no-ops, while unrelated database constraint failures are not swallowed.

This applies to events that supply a stable key; it does **not** make every workflow step or external side effect exactly-once.

### 9. Proposal-bound approval integrity

Approval decisions are associated with the proposal they approve or reject. The workflow rejects approval data whose proposal identity does not match the active proposal, and execution uses the stored proposal rather than trusting replacement action data supplied by a caller.

Commander authorization and current incident-state checks remain mandatory. Proposal binding supplements these checks; it does not replace them.

### 10. Atomic execution claims and completion

Approved simulated execution follows the guarded state progression `AWAITING_APPROVAL → EXECUTING → RESOLVED`:

1. The execution claim uses a conditional update scoped to the incident, organization, workflow run, and expected status.
2. The transition to `EXECUTING` and its proposal-specific claim event are committed together.
3. A superseded workflow does not continue through the simulated execution path.
4. The simulated `action_executed` record and transition to `RESOLVED` are committed in one database transaction.
5. A retry recognizes a previously recorded proposal-specific result instead of inserting a duplicate result.

**Limitation:** the current executor records a simulated action outcome. These database transactions do not provide exactly-once guarantees for real infrastructure operations or external provider side effects. Real external execution remains Phase 8 work.

### 11. Incident lifecycle transactions

Server-side status transitions are validated independently of the UI. Workflow-controlled statuses cannot be reached merely by sending a crafted status payload to a server action.

Conditional lifecycle state updates and associated audit events are written in the same database transaction. If a guarded transition fails or the event write fails, the transaction does not leave a partial state/event pair. Timeout, rejection, approval-mismatch, escalation, and other competing transitions use conditional updates to avoid overwriting a newer state.

### 12. Workflow-attempt ownership and retry fencing

The Phase 6 follow-up introduces `Incident.workflowAttemptToken`, a nullable text token used to fence workflow attempts from one another.

- A new incident workflow attempt receives a fresh token.
- Workflow claims are conditional on the incident, organization, expected status, workflow run, and attempt token.
- If a workflow attempt is stale or superseded, it must not proceed through triage or remediation using the newer attempt's state.
- Retry reservations use a compare-and-set update so concurrent retries cannot both acquire ownership.
- Eligible retries are limited to supported incident states and conditions indicating that the current run has finished or a trigger failed.
- An operator retry records an `incident_status_changed` audit event with the reason `operator_retry`.
- If a retry trigger fails, rollback is conditional on the expected attempt still owning the state. The rollback rotates the attempt token rather than clearing it to `null`, so a delayed tokenless legacy delivery cannot match a null token and reclaim the incident.
- If a concurrent operation has already changed the incident, the retry path reports the concurrent change rather than falsely claiming the incident returned to `OPEN`.
- Manual incident creation uses the transactional ingestion path with the `manual` source and an `incident_created` event, keeping persistence and workflow triggering on the shared ingestion path.

Token fencing protects ownership of workflow attempts; it is not a substitute for the workflow route's authorization, incident-state, and database-claim conditions.

#### Critical-severity triage guard

The triage agent now bypasses the LLM verdict for incidents whose severity is `CRITICAL` and returns `shouldInvestigate: true` after the existing suspected-prompt-injection scan. This prevents a model-level `SKIP` decision from silently stopping a critical incident before diagnosis. The bypass does not approve or execute remediation: diagnosis and proposal generation continue through the existing human-approval and blast-radius controls.

A regression test verifies that a `CRITICAL` incident proceeds to investigation without calling the LLM. The triage suite passed 7/7 tests, and the full suite subsequently passed 154 tests across 23 test files.

## Incident Event Streaming (SSE)

### 13. Monotonic sequence and replay behavior

Incident streaming uses a per-incident `streamSequence` cursor, backed by a PostgreSQL trigger, instead of relying on `createdAt` timestamps for ordering. Sequence allocation is serialized until the inserting transaction completes so a late commit cannot fall behind a cursor already advanced by a later event.

The stream:

- Parses `Last-Event-ID` as a non-negative safe integer, falling back to `0` for invalid values.
- Replays history in `streamSequence` order, with event ID as a deterministic secondary sort key.
- Advances the replay cursor after sending each new event, so the first polling query asks only for sequences beyond the replay.
- Polls with `streamSequence > lastSeenSequence` and retains event-ID deduplication as a defensive measure.
- Avoids replaying an event with a sequence at or before `Last-Event-ID`, while still checking whether a terminal event for the current workflow run has already been delivered.
- Recognizes current-run `workflow_finished` events using their workflow run identity, with external-ID compatibility for older event payloads.
- Rechecks organization membership and current incident status during polling.
- Closes after a bounded connection duration so EventSource can reconnect using its last delivered sequence.

A regression test covers an event with an older timestamp but a higher sequence, and tests cover reconnect/completion handling and replay-cursor advancement. Per-connection database polling remains; further SSE scaling and load characterization are deferred to Phase 7/10 work as planned.

### 14. Client recovery behavior

The incident stream provider deduplicates received events, handles stream completion, and supports restarting the stream. The incident timeline panel refreshes incident data and restarts the stream after retry errors as well as successful retry responses, because a failed trigger may have caused a server-side rollback or encountered a concurrent state change.

### 15. Current membership and role checks

The data-access layer verifies active-organization membership and role data from the database rather than relying exclusively on potentially stale session claims. Missing membership redirects to onboarding; a user whose current role does not satisfy a page's requirement is directed to the dashboard appropriate for the current role.

The shared application error UI does not rely on `error.message` string matching or automatically sign users out as a recovery heuristic.

## Additional Reliability and UI Polish

### 16. Simulated prompt-injection demo flag

Synthetic adversarial injection content in simulated alerts is gated by `ENABLE_INJECTION_DEMO`, which defaults to `false`. The normal simulated-alert path uses a non-adversarial description. This flag is intended for controlled demos and testing; it is not a claim that prompt-injection detection is complete.

### 17. Runbook embedding recovery

If initial runbook indexing fails, the saved runbook remains available and the UI directs the user to use **Re-index** rather than creating a duplicate by re-saving.

Re-indexing checks the current role and organization ownership, generates and validates embeddings before modifying stored chunks, then deletes and inserts chunks inside one database transaction. Embedding-generation failure does not modify the existing index; an insert failure is rolled back by the transaction. Re-index actions are available on Commander and Engineer runbook pages.

### 18. Accessibility and error boundaries

The incident reasoning feed exposes sequential updates through `role="log"`, `aria-live="polite"`, and `aria-relevant="additions"`.

A shared route-section recovery component supports route-level error boundaries for Commander, Engineer, and Observer. A separate incident-panel recovery component supports independent boundaries for Commander and Engineer reasoning and timeline panels. These boundaries provide retry UI; they do not replace production error monitoring.

### 19. Environment configuration

The unused `UPSTASH_WORKFLOW_URL` entry was removed from `.env.example`. `DIRECT_URL` remains used by `prisma.config.ts` and is documented in `.env.example`, CI, and the README. It is intentionally not part of the runtime `src/lib/env.ts` schema when consumed by Prisma CLI configuration rather than application runtime code.

## Database and Migration Reliability

### 20. Versioned migrations

Prisma migration history is tracked in version control, including `prisma/migrations/migration_lock.toml`. Database changes are delivered through versioned migrations rather than undocumented manual edits.

Earlier Phase 6 database work included:

- Restoring the `ESCALATION_REQUIRED` enum value and the `runbook_chunk_embedding_idx` HNSW vector index.
- Adding the `RunbookChunk` organization foreign-key constraint.
- Adding the `Event(incidentId, createdAt)` index for chronological event retrieval.
- Adding the `EXECUTING` incident status for the execution-claim lifecycle.

The current workflow-hardening change adds this migration:

`prisma/migrations/20261024150000_add_workflow_attempt_token/migration.sql`

```sql
ALTER TABLE "Incident"
ADD COLUMN "workflowAttemptToken" TEXT;
```

The new column is nullable to support existing incident rows.

For database setup, enable the `vector` extension before applying migrations if it is not already enabled. In migration-managed environments, use the tracked migration history and `npx prisma migrate deploy`; do not substitute `prisma db push` for applying committed migrations.

## Testing and Validation

### 21. Security-boundary tests

Webhook regression tests cover:

- IP-limit rejection with HTTP `429` before organization database lookup.
- No organization rate-limit consumption when HMAC verification fails.
- Organization-limit rejection after successful HMAC verification.
- Successful webhook processing through the existing ingestion path.

Commander approval tests cover explicit rate-limit rejection and the Redis-failure policy while retaining database authorization and state checks. Blast-radius tests cover both allowed simulated execution and blocked escalation, including the absence of `action_executed` on the blocked path. Serialization tests verify that durable workflow results exclude the `pending` Promise.

### 22. Workflow and streaming regression tests

Additional regression coverage includes:

- Retry reservation and audit-event creation.
- Compare-and-set race handling and failed-trigger rollback.
- Fresh attempt-token rotation after a definite trigger failure.
- Stale workflow attempt-token rejection before the agent pipeline runs.
- Rejection of a tokenless legacy delivery after rollback leaves a non-null fencing token.
- Workflow approval binding, execution claim ownership, and superseded completion paths.
- SSE replay ordering, `Last-Event-ID` completion recognition, and replay-cursor advancement before polling.

### 23. Latest reported local validation

The latest reported local validation run passed:

- `npm test` — **154 tests passed across 23 test files**.
- `npm run typecheck` — passed.
- `npm run lint` — passed.
- `npx prisma validate` — passed.
- `npm run build` — passed.
- `git diff --check` — passed at the reported checkpoints.

The local UI workflow was also exercised with the synthetic `Production Database CPU 98%` alert. It proceeded through critical triage, diagnosis, remediation proposal, human approval, the organization blast-radius check, execution claim, and the simulated completion path. The incident then displayed `RESOLVED` and the timeline recorded `action_executed`.

**Execution boundary:** `completeApprovedExecution()` documents that this is a simulated executor. The recorded event payload explicitly says no real infrastructure change was made. Thus the manual run verifies the approval/orchestration lifecycle, not the termination of real PostgreSQL sessions or other external remediation.

## Deferred Work

The following work remains outside Phase 6:

- **Phase 7:** real-Postgres concurrency and rollback verification, SQL-level tenant-isolation tests, and agent evaluations.
- **Phase 8:** real external infrastructure execution; current execution records a simulated outcome.
- **Phase 10:** SSE scaling and load characterization.
- **Phase 11:** public postmortem `sitemap.ts`, `robots.ts`, and Open Graph metadata, when public postmortem routes exist.

## Implementation Checklist

### Rate limiting and webhook ingestion

- [x] Implement Redis-backed rate limiting.
- [x] Add the public IP webhook limiter and organization ingestion limiter.
- [x] Add the per-user Commander approval limiter.
- [x] Add the organization-level execution limiter.
- [x] Apply the IP limiter before organization lookup.
- [x] Verify HMAC before charging the organization ingestion budget.
- [x] Preserve payload validation and idempotent ingestion.
- [x] Document Redis failure policies and trusted-proxy assumptions.

### Approval and blast-radius control

- [x] Preserve database-backed Commander authorization and approval-state checks.
- [x] Bind approval decisions to the active proposal identity.
- [x] Enforce the organization execution budget after approval and before simulated execution.
- [x] Escalate over-budget attempts without emitting `action_executed`.
- [x] Keep durable workflow-step results serializable.

### Workflow and lifecycle reliability

- [x] Persist supported workflow-event deduplication keys.
- [x] Guard execution claims and completion with conditional updates and transactions.
- [x] Enforce incident status transitions on the server.
- [x] Commit conditional lifecycle transitions and audit events together.
- [x] Add `workflowAttemptToken` to fence stale and superseded workflow attempts.
- [x] Rotate the attempt token after a definite retry-trigger failure rather than clearing it to `null`.
- [x] Record operator retry audit events and report concurrent changes honestly.
- [x] Cover stale-token and tokenless-legacy-delivery behavior with tests.

### Streaming, UI, and operations

- [x] Use monotonic per-incident `streamSequence` for SSE replay and polling.
- [x] Advance the replay cursor before polling for newer events.
- [x] Recognize workflow completion for the current run across reconnects.
- [x] Refresh incident data and restart streaming after retry errors.
- [x] Add runbook re-index recovery, accessible live announcements, and error boundaries.
- [x] Gate simulated prompt-injection content with `ENABLE_INJECTION_DEMO`.
- [x] Remove unused `UPSTASH_WORKFLOW_URL` from `.env.example` and document `DIRECT_URL` usage.
- [x] Add the CRITICAL-severity triage guard and regression coverage.
- [x] Validate locally with tests, typecheck, lint, Prisma validation, Prisma Client generation, and production build.
- [x] Apply the `workflowAttemptToken` migration to the Neon database configured by the local `.env`; verify that Prisma reports no pending migrations.

## Definition of Done

- [x] Public webhook requests are rate-limited before organization database lookup.
- [x] Organization ingestion limits are applied only after successful HMAC verification.
- [x] Commander approval remains human-authorized and guarded by current role and incident state.
- [x] Organization-level execution limits are enforced after approval and before simulated execution.
- [x] Over-budget execution is explicitly escalated rather than executed.
- [x] Supported workflow events use stable deduplication identities.
- [x] Approval decisions are bound to the proposal identity.
- [x] Execution claims, simulated completion, and lifecycle audit records are guarded transactionally.
- [x] Retry attempts are fenced by tokens, including rollback and delayed legacy-delivery paths.
- [x] SSE ordering, reconnect behavior, and terminal completion have regression coverage.
- [x] Critical incidents bypass an LLM `SKIP` verdict and proceed to diagnosis.
- [x] Latest reported local validation passed: 154 tests across 23 test files, typecheck, lint, Prisma Client generation, and production build.
- [x] The local synthetic-alert workflow reached approval and completed the simulated execution path.
- [~] Public postmortem metadata remains deferred to Phase 11.

## Final Architectural Outcome

Phase 6 adds resource-level controls, explicit workflow ownership, guarded retries, monotonic event replay, and UI recovery without changing Sentinel's core trust model. Authentication, authorization, rate limiting, human approval, execution control, and workflow-attempt ownership retain distinct responsibilities.

When an operation cannot proceed, the system records a guarded failure or explicit escalation rather than silently bypassing a security boundary. Critical-severity incidents proceed to diagnosis without relying on an LLM triage verdict, while proposed remediation still requires human approval and passes through the organization-level execution budget. The current executor remains simulated; real external execution is deferred to Phase 8. The `workflowAttemptToken` migration is applied to the Neon database configured by the local `.env`; the intended deployment database must be checked and migrated separately before deployment.
