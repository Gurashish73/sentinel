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

The phase also hardens the incident event stream, recovers organization context from current database membership, clarifies retry eligibility, removes unused status controls, and adds dedicated PostgreSQL integration-test coverage.

## Security Architecture and Runtime Boundaries

### 1. Defense-in-depth rate limiting

Rate limiting is enforced at multiple independent boundaries. Passing one limiter does not imply that a request is permitted by the next.

| Boundary | Scope | Limit | Window |
|---|---|---:|---|
| Public webhook | Client IP | 30 requests | 10 seconds |
| Webhook ingestion | Organization | 60 requests | 60 seconds |
| Commander approval | User | 10 actions | 60 seconds |
| Investigation starts | Organization | 30 starts | 1 hour |
| Remediation execution | Organization | 10 executions | 1 hour |

Redis-backed state allows request budgets to be shared across application instances rather than maintained in process-local memory. Redis URL and token configuration are required by the runtime environment schema in `src/lib/env.ts`.

The investigation-start limiter is distinct from the execution limiter:

- The **investigation-start limit** constrains how frequently a new workflow can be launched for an organization.
- The **execution limit** constrains how many approved simulated remediation executions an organization can perform.

The two budgets protect different stages and are not interchangeable.

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
- **Investigation starts:** fails closed if the organization's start budget cannot be established.
- **Remediation execution:** fails closed if the execution budget cannot be established.
- **Commander approval:** an explicit rate-limit denial rejects the request, but a Redis infrastructure failure does not independently remove the human-approval path.

The approval path still requires database-backed Commander authorization, an incident in `AWAITING_APPROVAL`, and the existing stale/duplicate-state guards. During a Redis outage, approval may proceed without the additional rate-limit protection, but it does not bypass authorization or incident-state validation.

For a blocked investigation start, the incident record remains persisted, a failed workflow outcome is recorded, and no QStash workflow trigger is issued. The incident can be retried through the supported retry path when the organization's budget is available again.

### 4. Client IP and proxy assumptions

`getClientIp()` uses the `x-forwarded-for` and `x-real-ip` headers. Those headers are trustworthy only when the deployment establishes a trusted proxy boundary.

The public reverse proxy must sanitize or overwrite forwarding headers. A self-hosted deployment that blindly trusts client-supplied forwarding headers can weaken IP-based limits because clients may manipulate the rate-limit key.

### 5. Investigation-start rate limiting

The investigation-start limiter allows **30 workflow starts per organization per hour**.

All identified paths that launch a new investigation use the shared ingestion/trigger path or the shared `triggerIncidentWorkflow()` path. This includes manual incident creation, webhook and synthetic-alert ingestion, duplicate recovery, and Commander retry. Approval notification for an existing workflow is not a new investigation start.

The quota is checked once per logical workflow start, before the QStash trigger retry loop. A transient QStash delivery retry therefore does not consume the organization's start quota repeatedly.

The policy is uniform: **critical-severity incidents do not bypass the investigation-start quota**. If the quota is exhausted, or Redis cannot establish the budget, the start fails closed. The incident is retained and its workflow failure is made visible; the system does not silently trigger a workflow outside the budget.

The investigation-start limiter does not replace the execution limiter. A workflow that starts successfully must still obtain Commander approval and pass the organization-level execution budget before simulated remediation.

## Blast-Radius Control

### 6. Organization-level execution budget

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
  Budget Allowed             Budget Exceeded
        |                          |
        v                          v
Execute Simulated            ESCALATION_REQUIRED
Remediation                         |
        |                           v
        v                    Record Escalation
 action_executed                     |
                                    v
                             workflow_finished
```

The budget is organization-scoped so multiple Commanders in one organization share the same limit. It is an execution control, not an approval mechanism: the proposed action must first pass the existing human approval workflow.

### 7. Explicit escalation on limit exhaustion

If the execution budget is exceeded, the blocked remediation is not executed. The workflow:

1. Does not emit `action_executed` for the blocked action.
2. Transitions the incident to `ESCALATION_REQUIRED`.
3. Records a `blast_radius_exceeded` event.
4. Emits a terminal `workflow_finished` event with reason `blast_radius_exceeded`.

This is an explicit operational outcome, not a claim that the remediation was executed or the incident resolved.

### 8. Durable workflow-step serialization

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

### 9. Workflow-event idempotency

Supported workflow events can use stable deduplication keys persisted through `Event.externalId`. The unique `(orgId, externalId)` constraint identifies repeated logical events. Repeated writes with the same stable key become no-ops, while unrelated database constraint failures are not swallowed.

This applies to events that supply a stable key; it does **not** make every workflow step or external side effect exactly-once.

### 10. Proposal-bound approval integrity

Approval decisions are associated with the proposal they approve or reject. The workflow rejects approval data whose proposal identity does not match the active proposal, and execution uses the stored proposal rather than trusting replacement action data supplied by a caller.

Commander authorization and current incident-state checks remain mandatory. Proposal binding supplements these checks; it does not replace them.

### 11. Atomic execution claims and completion

Approved simulated execution follows the guarded state progression `AWAITING_APPROVAL → EXECUTING → RESOLVED`:

1. The execution claim uses a conditional update scoped to the incident, organization, workflow run, and expected status.
2. The transition to `EXECUTING` and its proposal-specific claim event are committed together.
3. A superseded workflow does not continue through the simulated execution path.
4. The simulated `action_executed` record and transition to `RESOLVED` are committed in one database transaction.
5. A retry recognizes a previously recorded proposal-specific result instead of inserting a duplicate result.

**Limitation:** the current executor records a simulated action outcome. These database transactions do not provide exactly-once guarantees for real infrastructure operations or external provider side effects. Real external execution remains Phase 8 work.

### 12. Incident lifecycle transactions and status-control cleanup

Server-side lifecycle changes remain guarded by conditional database operations and workflow ownership checks. Workflow-controlled statuses cannot be reached merely by sending a crafted status payload to a UI control.

Conditional lifecycle state updates and associated audit events are written in the same database transaction. If a guarded transition fails or the event write fails, the transaction does not leave a partial state/event pair. Timeout, rejection, approval-mismatch, escalation, and other competing transitions use conditional updates to avoid overwriting a newer state.

The unused generic status-management path was removed during Phase 6 cleanup:

- The `StatusControls` component was deleted because it had no consumers and its configured transition lists were empty.
- The unused `updateIncidentStatus` server action and its transition constants/schema were removed.
- Retry behavior, guarded workflow transitions, and their audit-event logic were retained.

This removes a no-op UI/action path; it does not remove the workflow's guarded lifecycle handling.

### 13. Workflow-attempt ownership and retry fencing

The Phase 6 follow-up introduces `Incident.workflowAttemptToken`, a nullable text token used to fence workflow attempts from one another.

- A new incident workflow attempt receives a fresh token.
- Workflow claims are conditional on the incident, organization, expected status, workflow run, and attempt token.
- If a workflow attempt is stale or superseded, it must not proceed through triage or remediation using the newer attempt's state.
- Retry reservations use a compare-and-set update so concurrent retries cannot both acquire ownership.
- Eligible retries are limited to supported incident states and conditions indicating that the current run has finished or a trigger failed.
- Retry eligibility is evaluated against the current workflow run and its terminal outcome. Supported terminal reasons include `rejected`, `timed_out`, `skipped`, `no_proposal`, `approval_mismatch`, `blast_radius_exceeded`, and `failed`.
- Legacy terminal events without an embedded workflow run identity are accepted only through the exact external-ID prefix associated with the current run. A stale run, resolved incident, or missing current workflow identity is not treated as retryable by that fallback.
- An operator retry records an `incident_status_changed` audit event with the reason `operator_retry`.
- If a retry trigger fails, rollback is conditional on the expected attempt still owning the state. The rollback rotates the attempt token rather than clearing it to `null`, so a delayed tokenless legacy delivery cannot match a null token and reclaim the incident.
- If a concurrent operation has already changed the incident, the retry path reports the concurrent change rather than falsely claiming the incident returned to `OPEN`.
- Manual incident creation uses the transactional ingestion path with the `manual` source and an `incident_created` event, keeping persistence and workflow triggering on the shared ingestion path.

The timeline uses the shared retry-eligibility helper rather than independently guessing from incident status. An `OPEN` incident with no workflow run can be offered as retryable where appropriate; `ESCALATION_REQUIRED` requires a qualifying terminal workflow result.

Token fencing protects ownership of workflow attempts; it is not a substitute for the workflow route's authorization, incident-state, and database-claim conditions.

#### Critical-severity triage guard

The triage agent bypasses the LLM verdict for incidents whose severity is `CRITICAL` and returns `shouldInvestigate: true` after the existing suspected-prompt-injection scan. This prevents a model-level `SKIP` decision from silently stopping a critical incident before diagnosis. The bypass does not approve or execute remediation: diagnosis and proposal generation continue through the existing human-approval and blast-radius controls.

A regression test verifies that a `CRITICAL` incident proceeds to investigation without calling the LLM.

## Incident Event Streaming (SSE)

### 14. Monotonic sequence and replay behavior

Incident streaming uses a per-incident `streamSequence` cursor, backed by a PostgreSQL trigger, instead of relying on `createdAt` timestamps for ordering. Sequence allocation is serialized until the inserting transaction completes so a late commit cannot fall behind a cursor already advanced by a later event.

The stream:

- Parses `Last-Event-ID` as a non-negative safe integer, falling back to `0` for invalid values.
- Replays history in `streamSequence` order, with event ID as a deterministic secondary sort key.
- Advances the replay cursor after sending each new event, so the first polling query asks only for sequences beyond the replay.
- Polls with `streamSequence > lastSeenSequence` and retains event-ID deduplication as a defensive measure.
- Avoids replaying an event with a sequence at or before `Last-Event-ID`, while still checking whether a terminal event for the current workflow run has already been delivered.
- Recognizes current-run `workflow_finished` events using their workflow run identity, with external-ID compatibility for older event payloads.
- Rechecks organization membership and current incident status during polling.
- Detects incident deletion and closes the stream instead of continuing to poll a missing record.
- Applies a bounded connection lifetime (`MAX_STREAM_MS = 280_000`) and an inactivity grace period (`INACTIVE_STREAM_GRACE_MS = 15_000`) so EventSource can reconnect using its last delivered sequence.
- Ends a maximum-lifetime connection cleanly rather than falsely reporting that the workflow itself is complete.

A regression test covers an event with an older timestamp but a higher sequence. Route tests cover replay ordering, `Last-Event-ID`, cursor advancement, inactive streams, authentication and membership checks, incident deletion, membership revocation, and maximum connection lifetime. Per-connection database polling remains; further SSE scaling and load characterization are deferred to Phase 7/10 work as planned.

### 15. Client recovery behavior

The incident stream provider deduplicates received events, handles stream completion, and supports restarting the stream.

Client visibility handling is explicit:

- The stream pauses while the browser tab is hidden.
- Returning to a visible tab triggers reconnection.
- Visibility changes do not restart a stream after `workflowFinished` has been received.

The incident timeline panel refreshes incident data and restarts the stream after retry errors as well as successful retry responses, because a failed trigger may have caused a server-side rollback or encountered a concurrent state change.

### 16. Current membership and role checks

The data-access layer verifies active-organization membership and role data from the database rather than relying exclusively on potentially stale session claims.

The cached DAL resolves the user's current membership using the active organization when that membership is valid. If the session's `activeOrgId` is missing or stale, it falls back to a database-backed membership lookup for that user and constructs the application session using the resolved organization and role. A user with no organization membership is sent through onboarding rather than being treated as a member based on stale session data.

The proxy no longer performs redirects based on stale organization or role claims that are corrected by the DAL. Authorization still depends on the current database-backed membership and role.

The shared application error UI does not rely on `error.message` string matching or automatically sign users out as a recovery heuristic.

## Additional Reliability and UI Polish

### 17. Simulated prompt-injection demo flag

Synthetic adversarial injection content in simulated alerts is gated by `ENABLE_INJECTION_DEMO`, which defaults to `false`. The normal simulated-alert path uses a non-adversarial description. This flag is intended for controlled demos and testing; it is not a claim that prompt-injection detection is complete.

### 18. Runbook embedding recovery

If initial runbook indexing fails, the saved runbook remains available and the UI directs the user to use **Re-index** rather than creating a duplicate by re-saving.

Re-indexing checks the current role and organization ownership, generates and validates embeddings before modifying stored chunks, then deletes and inserts chunks inside one database transaction. Embedding-generation failure does not modify the existing index; an insert failure is rolled back by the transaction. Re-index actions are available on Commander and Engineer runbook pages.

### 19. Accessibility and error boundaries

The incident reasoning feed exposes sequential updates through `role="log"`, `aria-live="polite"`, and `aria-relevant="additions"`.

A shared route-section recovery component supports route-level error boundaries for Commander, Engineer, and Observer. A separate incident-panel recovery component supports independent error boundaries for Commander, Engineer, and Observer reasoning and timeline panels. The Observer timeline and reasoning slots now have their own `error.tsx` boundaries, matching the independent recovery behavior already provided for the other roles.

These boundaries provide retry UI; they do not replace production error monitoring. Observer access remains read-only and its permission model is unchanged.

### 20. Environment configuration

The unused `UPSTASH_WORKFLOW_URL` entry was removed from `.env.example`. `DIRECT_URL` remains used by `prisma.config.ts` and is documented in `.env.example`, CI, and the README. It is intentionally not part of the runtime `src/lib/env.ts` schema when consumed by Prisma CLI configuration rather than application runtime code.

## Database and Migration Reliability

### 21. Versioned migrations and database state

Prisma migration history is tracked in version control, including `prisma/migrations/migration_lock.toml`. Database changes are delivered through versioned migrations rather than undocumented manual edits.

Earlier Phase 6 database work included:

- Restoring the `ESCALATION_REQUIRED` enum value and the `runbook_chunk_embedding_idx` HNSW vector index.
- Adding the `RunbookChunk` organization foreign-key constraint.
- Adding the `Event(incidentId, createdAt)` index for chronological event retrieval.
- Adding the `EXECUTING` incident status for the execution-claim lifecycle.

The workflow-hardening change adds this migration:

`prisma/migrations/20261024150000_add_workflow_attempt_token/migration.sql`

```sql
ALTER TABLE "Incident"
ADD COLUMN "workflowAttemptToken" TEXT;
```

The new column is nullable to support existing incident rows.

The event-stream migration adds `streamSequence`, the `EventStreamCursor` table, the unique `(incidentId, streamSequence)` constraint, and a PostgreSQL trigger that assigns the next sequence before an event insert. The trigger updates the per-incident cursor in the inserting transaction, serializing sequence allocation for that incident until the transaction completes.

For database setup, enable the `vector` extension before applying migrations if it is not already enabled. In migration-managed environments, use the tracked migration history and `npx prisma migrate deploy`; do not substitute `prisma db push` for applying migrations.

#### Dedicated Neon integration-test database

A separate Neon project, `Sentinel-Test`, was created for integration testing. Its database is named `sentinel_test`, and the test connection uses the direct, non-pooled Neon endpoint. The test setup validates that:

- The host is a Neon endpoint ending in `.neon.tech`.
- The host is not a pooled endpoint containing `-pooler`.
- The database name is exactly `sentinel_test`.

The connection is configured through `TEST_DATABASE_URL` in the local `.env`. The `.env` file is git-ignored; the connection string and credentials are not part of the repository or this documentation.

All ten tracked Prisma migrations were applied successfully to this dedicated test database. The migration command output identified the target as `sentinel_test`, and the database was checked for the expected event-stream and workflow-attempt schema objects. The production database was not used for these integration tests.

The integration setup is deliberately separate from the default unit-test setup. `vitest.config.ts` includes only `src/**/*.test.ts` and `src/**/*.test.tsx`; `vitest.integration.config.ts` runs `tests/integration/**/*.test.ts` with its own setup file. The package script is:

```json
{
  "test:integration": "vitest run --config vitest.integration.config.ts"
}
```

This prevents the default `npm test` command from unexpectedly connecting to Neon. It also makes the real-database test requirement explicit.

## Testing and Validation

### 22. Security-boundary tests

Webhook regression tests cover:

- IP-limit rejection with HTTP `429` before organization database lookup.
- No organization rate-limit consumption when HMAC verification fails.
- Organization-limit rejection after successful HMAC verification.
- Successful webhook processing through the existing ingestion path.

Investigation-start tests cover:

- The per-organization start limiter being checked before a QStash workflow trigger.
- The quota being checked once per logical trigger, not once per transient QStash retry.
- Commander retry using the same start limiter.
- A blocked retry not issuing a QStash trigger.
- Fail-closed behavior when Redis cannot establish the limit.

Commander approval tests cover explicit rate-limit rejection and the Redis-failure policy while retaining database authorization and state checks. Blast-radius tests cover both allowed simulated execution and blocked escalation, including the absence of `action_executed` on the blocked path. Serialization tests verify that durable workflow results exclude the `pending` Promise.

### 23. Workflow and streaming regression tests

Additional regression coverage includes:

- Retry reservation and audit-event creation.
- Compare-and-set race handling and failed-trigger rollback.
- Fresh attempt-token rotation after a definite trigger failure.
- Stale workflow attempt-token rejection before the agent pipeline runs.
- Rejection of a tokenless legacy delivery after rollback leaves a non-null fencing token.
- Workflow approval binding, execution claim ownership, and superseded completion paths.
- Retry eligibility for supported terminal outcomes, including current-run matching and legacy external-ID matching.
- SSE replay ordering, `Last-Event-ID` completion recognition, and replay-cursor advancement before polling.
- SSE authentication, membership revocation, missing/deleted incident handling, inactivity, and maximum connection lifetime.
- Client stream pause/resume behavior across browser visibility changes and no restart after workflow completion.
- Organization recovery when `activeOrgId` is missing or stale, including the no-membership onboarding path.
- Observer incident timeline and reasoning panel error recovery.

### 24. Latest reported local validation

The latest reported validation run passed:

| Validation | Result |
|---|---|
| `npm test` | **200 tests passed across 29 test files** |
| `npm run test:integration` | **4 PostgreSQL integration tests passed** |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm run build` | Passed; 12/12 static pages generated |
| `git diff --check` | Passed |

The default unit-test run and PostgreSQL integration-test run are separate commands. The four integration tests use the dedicated Neon `sentinel_test` database rather than mocks.

#### What the PostgreSQL integration tests verify

The current integration suite verifies four database-level behaviors:

1. **Commit-ordered event sequence allocation:** inserts 20 events against the real PostgreSQL database and verifies that their `streamSequence` values are unique and contiguous.
2. **Workflow-claim contention predicate:** executes the database claim predicate directly under contention and verifies that only one competing claim wins.
3. **Stale-attempt fencing predicate:** executes the database predicate directly and verifies that an old attempt token cannot claim after a newer retry owns the incident.
4. **Concurrent failure transaction behavior:** reproduces the failure-callback database transaction logic and verifies that concurrent failure handling produces only one terminal event.

**Integration-test scope limitation:** tests 2 and 3 exercise the relevant SQL/database predicates directly; they do not invoke the complete production workflow route. Test 4 reproduces the database transaction behavior; it does not invoke the actual Upstash `failureFunction` handler. These tests therefore provide real-PostgreSQL verification of the trigger, claim predicates, stale-token condition, and transaction behavior, but they are not a full end-to-end test of the HTTP workflow route or Upstash callback delivery.

The local UI workflow was also exercised with the synthetic `Production Database CPU 98%` alert. It proceeded through critical triage, diagnosis, remediation proposal, human approval, the organization blast-radius check, execution claim, and the simulated completion path. The incident then displayed `RESOLVED` and the timeline recorded `action_executed`.

**Execution boundary:** `completeApprovedExecution()` documents that this is a simulated executor. The recorded event payload explicitly says no real infrastructure change was made. Thus the manual run verifies the approval/orchestration lifecycle, not the termination of real PostgreSQL sessions or other external remediation.

## Deferred Work

The following work remains outside the completed Phase 6 scope:

- **Phase 7:** broader real-PostgreSQL transaction rollback verification, SQL-level tenant-isolation tests, end-to-end workflow-route and actual Upstash failure-callback integration tests, and agent evaluations. Phase 6 now has a dedicated Neon integration database and four focused database-level integration tests; those tests do not complete the broader Phase 7 verification scope described here.
- **Phase 8:** real external infrastructure execution; current execution records a simulated outcome.
- **Phase 10:** SSE scaling and load characterization.
- **Phase 11:** public postmortem `sitemap.ts`, `robots.ts`, and Open Graph metadata, when public postmortem routes exist.

## Implementation Checklist

### Rate limiting and webhook ingestion

- [x] Implement Redis-backed rate limiting.
- [x] Add the public IP webhook limiter and organization ingestion limiter.
- [x] Add the per-user Commander approval limiter.
- [x] Add the organization-level investigation-start limiter (30 starts per hour).
- [x] Add the organization-level execution limiter.
- [x] Apply the IP limiter before organization lookup.
- [x] Verify HMAC before charging the organization ingestion budget.
- [x] Apply the investigation-start budget once per logical trigger, including Commander retries.
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
- [x] Keep workflow-controlled lifecycle transitions behind server-side guards.
- [x] Commit conditional lifecycle transitions and audit events together.
- [x] Remove the unused generic status action and no-op `StatusControls` component without removing retry or workflow lifecycle logic.
- [x] Add `workflowAttemptToken` to fence stale and superseded workflow attempts.
- [x] Rotate the attempt token after a definite retry-trigger failure rather than clearing it to `null`.
- [x] Record operator retry audit events and report concurrent changes honestly.
- [x] Centralize retry eligibility and require current-run or exact legacy-event matching.
- [x] Cover stale-token and tokenless-legacy-delivery behavior with tests.
- [x] Recover a missing or stale active organization from current database membership.

### Streaming, UI, and operations

- [x] Use monotonic per-incident `streamSequence` for SSE replay and polling.
- [x] Advance the replay cursor before polling for newer events.
- [x] Recognize workflow completion for the current run across reconnects.
- [x] Refresh incident data and restart streaming after retry errors.
- [x] Pause SSE while the browser tab is hidden and reconnect when it becomes visible.
- [x] Avoid restarting a stream after workflow completion.
- [x] Add runbook re-index recovery, accessible live announcements, and route/panel error boundaries.
- [x] Add independent Observer incident timeline and reasoning panel error boundaries.
- [x] Gate simulated prompt-injection content with `ENABLE_INJECTION_DEMO`.
- [x] Remove unused `UPSTASH_WORKFLOW_URL` from `.env.example` and document `DIRECT_URL` usage.
- [x] Add the CRITICAL-severity triage guard and regression coverage.

### Database and validation

- [x] Track database changes through Prisma migrations.
- [x] Apply all ten tracked migrations to the dedicated Neon `sentinel_test` database.
- [x] Keep PostgreSQL integration tests separate from the default unit-test command.
- [x] Verify commit-ordered event sequence allocation against real PostgreSQL.
- [x] Add database-level tests for competing workflow claims and stale attempt tokens.
- [x] Validate locally with unit tests, PostgreSQL integration tests, typecheck, lint, and production build.
- [x] Verify `git diff --check`.

## Definition of Done

- [x] Public webhook requests are rate-limited before organization database lookup.
- [x] Organization ingestion limits are applied only after successful HMAC verification.
- [x] Investigation starts are limited to 30 per organization per hour across the identified trigger paths.
- [x] Commander approval remains human-authorized and guarded by current role and incident state.
- [x] Organization-level execution limits are enforced after approval and before simulated execution.
- [x] Over-budget execution is explicitly escalated rather than executed.
- [x] Supported workflow events use stable deduplication identities.
- [x] Approval decisions are bound to the proposal identity.
- [x] Execution claims, simulated completion, and lifecycle audit records are guarded transactionally.
- [x] Retry attempts are fenced by tokens, including rollback and delayed legacy-delivery paths.
- [x] SSE ordering, reconnect behavior, and terminal completion have regression coverage.
- [x] Organization and role resolution use current database-backed membership.
- [x] Observer timeline and reasoning panels have independent error recovery.
- [x] Critical incidents bypass an LLM `SKIP` verdict and proceed to diagnosis.
- [x] The default unit suite passes: 200 tests across 29 test files.
- [x] The separate Neon PostgreSQL integration suite passes: 4 tests, with the scope limitations documented above.
- [x] Typecheck, lint, production build, and `git diff --check` pass.
- [x] The local synthetic-alert workflow reached approval and completed the simulated execution path.
- [ ] Broader PostgreSQL rollback and tenant-isolation verification, actual Upstash callback integration, and agent evaluations remain in Phase 7.
- [ ] Public postmortem metadata remains deferred to Phase 11.

## Final Architectural Outcome

Phase 6 adds resource-level controls, explicit workflow ownership, guarded retries, monotonic event replay, database-backed organization recovery, and UI recovery without changing Sentinel's core trust model. Authentication, authorization, rate limiting, human approval, execution control, and workflow-attempt ownership retain distinct responsibilities.

Investigation starts and approved simulated executions have separate organization-level budgets. When an operation cannot proceed, the system records a guarded failure or explicit escalation rather than silently bypassing a security boundary. Critical-severity incidents proceed to diagnosis without relying on an LLM triage verdict, while proposed remediation still requires human approval and passes through the organization-level execution budget.

The test strategy now separates fast unit tests from a dedicated real-PostgreSQL integration suite. The Neon `sentinel_test` database has all ten tracked migrations applied. The integration suite verifies event sequence allocation and selected concurrency predicates against PostgreSQL, while broader transaction rollback, tenant-isolation, and actual Upstash callback integration remain explicit follow-up work.

The current executor remains simulated; real external execution is deferred to Phase 8. The `workflowAttemptToken` migration is applied to the dedicated Neon test database configured through the local `.env`; the intended deployment database must be checked and migrated separately before deployment.
