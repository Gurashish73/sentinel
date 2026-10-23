# Phase 6 — Hardening, Reliability & Polish
## Overview
Phase 6 introduces an additional security layer around Sentinel's public webhook ingestion pipeline and human-approved remediation workflow.

Previous phases established the core security boundaries:

- Phase 1 introduced database-backed authorization and strict organizational isolation.
- Phase 2 implemented HMAC-authenticated webhook ingestion and idempotent event persistence.
- Phase 3 established durable agent orchestration with a mandatory Commander approval gate.
- Phase 4.5 hardened agent inputs against prompt injection while preserving human control.
- Phase 5 introduced organization-scoped retrieval with explicit trust boundaries.

However, authenticated ingestion and human approval do not independently prevent excessive request volume or repeated execution of approved actions.

Phase 6 addresses these risks through Redis-backed rate limiting, organization-level ingestion budgets, per-user approval limits, and execution blast-radius controls.

The objective is not to replace existing authorization mechanisms. It is to constrain the frequency and volume of operations while preserving Sentinel's existing security model: external requests remain untrusted, agent proposals remain subject to human approval, and infrastructure actions cannot bypass the established authorization boundary.

This document records Phase 6 hardening, including rate limiting, blast-radius controls, migration reproducibility, workflow-event idempotency, proposal-bound approvals, atomic execution claims, transactional incident lifecycle updates, and reliability/UI polish. The follow-up adds monotonic per-incident SSE sequencing backed by a PostgreSQL trigger, database-backed role checks, a demo-only injection flag, runbook re-index recovery, accessible live announcements, and error boundaries for incident panels and role sections. Local validation passed 145 tests across 23 test files; TypeScript typechecking, ESLint, Prisma schema validation, and `npm run build` passed. Public postmortem metadata remains deferred to Phase 11.

---
## Security Architecture & Runtime Boundaries
### 1. Defense-in-Depth Rate Limiting
Rate limiting is implemented at multiple boundaries rather than relying on a single global request limit.

Each limiter protects a different resource:

| Boundary | Scope | Limit | Window |
|---|---|---:|---|
| Public webhook | Client IP | 30 requests | 10 seconds |
| Webhook ingestion | Organization | 60 requests | 60 seconds |
| Commander approval | User | 10 actions | 60 seconds |
| Remediation execution | Organization | 10 executions | 1 hour |

The limits are independent budgets. Passing one limiter does not imply that a request is permitted by the next.

The public IP limiter reduces excessive traffic before database access. The organization limiter constrains authenticated ingestion across an organization's webhook traffic. The Commander limiter adds protection against excessive approval requests, while the execution limiter places an upper bound on the volume of remediation executions within an organization.

The limiters use Redis-backed state so that request budgets can be shared across application instances rather than being maintained in process-local memory.

---
### 2. Webhook Request Ordering
Webhook ingestion follows an explicit sequence:

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

This ordering is deliberate.

#### IP-level protection
The IP limiter executes before organization lookup. Excessive traffic can therefore be rejected without first performing a database query for every request.

Requests exceeding the configured IP budget receive an HTTP `429 Too Many Requests` response.

#### Organization-level protection
The organization limiter executes only after the organization has been resolved and the webhook signature has been verified.

This avoids allowing unsigned requests to consume the legitimate organization's ingestion budget.

If HMAC verification fails, the request is rejected without consuming the organization-level rate-limit bucket.

#### Payload validation and ingestion
Only requests that pass both rate-limit boundaries and HMAC verification proceed to payload validation and the existing ingestion pipeline.

The existing ingestion behavior remains responsible for validating payloads, handling duplicate deliveries, and persisting incidents and events. Rate limiting supplements these guarantees rather than replacing them.

---
## Redis Infrastructure & Failure Semantics
### 3. Centralized Rate-Limit Infrastructure
Redis is used as the shared state backend for the rate-limit implementation.

The rate-limit configuration is centralized so that webhook ingestion, Commander approval, and remediation execution use consistent infrastructure and explicitly defined budgets.

The Redis URL and token are required by the runtime environment schema in `src/lib/env.ts`.

Making these values mandatory prevents the application from silently treating the rate-limiting backend as an optional dependency.

The implementation also keeps the limiter response separate from the application-specific behavior that follows a successful or rejected rate-limit check.

This allows each boundary to apply its own failure policy without duplicating the underlying rate-limit configuration.

---
### 4. Fail-Closed Ingestion and Execution
Webhook ingestion and remediation execution fail closed when their required rate-limit operation cannot be completed successfully.

These boundaries protect resources and operations that must not proceed without their security controls.

For webhook ingestion, a Redis failure must not silently bypass the configured request budgets.

For remediation execution, a Redis failure must not allow an action to proceed without establishing that the execution budget permits it.

An infrastructure failure is therefore distinct from an ordinary rate-limit denial, but neither condition should silently authorize the protected operation.

This policy prioritizes the integrity of ingestion and execution boundaries over availability when the limiting infrastructure is unavailable.

---
### 5. Commander Approval Availability
Commander approval follows a deliberately different failure policy.

The approval limiter provides defense-in-depth protection against excessive approval requests, but Redis availability is not allowed to become the sole dependency of the human-approval path.

The behavior is:

- An explicit rate-limit denial rejects the approval request.
- A Redis infrastructure failure does not independently remove the approval path.
- Existing database-backed Commander authorization remains mandatory.
- The incident must still be in `AWAITING_APPROVAL`.
- Stale or duplicate approval attempts remain subject to the existing state guard.

This distinction is intentional.

The human approval boundary remains the mechanism that authorizes a proposed remediation. The rate limiter constrains the frequency of approval requests but does not replace authorization or incident-state validation.

**Known trade-off:** If Redis becomes unavailable, approval requests may proceed without rate limiting, provided the existing authorization and state checks succeed. This preserves human availability but temporarily removes the approval limiter's additional protection.

The webhook and execution limiters remain fail-closed because bypassing those controls would directly weaken ingestion or execution boundaries.

---
## Blast-Radius Control
### 6. Organization-Level Execution Budget
The execution limiter protects against excessive remediation execution within a single organization.

The configured budget is 10 executions per organization per hour.

The limiter is evaluated after the Commander has approved the proposed action and immediately before the simulated execution step.

```text
Proposed Remediation
        |
        v
Commander Approval
        |
        v
Existing Authorization
        |
        v
Existing Approval-State Validation
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
Execute Simulated          ESCALATION_REQUIRED
   Remediation                     |
        |                          v
        v                   Record Escalation
action_executed                    |
                                   v
                            workflow_finished
```

The execution budget is organization-scoped rather than user-scoped. This prevents the limit from being treated as an independent allowance for every Commander in the same organization.

The limiter is not an approval mechanism. A Commander must first authorize the proposed action through the existing workflow. The execution limiter then determines whether the approved action can proceed under the organization's current execution budget.

---
### 7. Explicit Escalation Instead of Silent Execution Failure
When the execution budget is exceeded, Sentinel does not execute the blocked remediation.

Instead, the workflow records an explicit escalation outcome.

The blocked path performs the following operations:

1. Does not emit an `action_executed` event.
2. Transitions the incident to `ESCALATION_REQUIRED`.
3. Records a `blast_radius_exceeded` event.
4. Emits a terminal `workflow_finished` event with reason `blast_radius_exceeded`.

This creates a distinguishable operational outcome rather than leaving the incident in an ambiguous intermediate state.

The escalation state indicates that the Commander-approved action could not proceed because the organization's execution budget was exceeded. It does not imply that the remediation was executed or that the incident was resolved.

The terminal workflow event also allows downstream consumers to recognize that the workflow has finished processing this execution attempt.

---
### 8. Durable Workflow Step Serialization
The blast-radius limiter is executed inside an Upstash Workflow `context.run()` step.

Durable workflow steps must return values that can be safely serialized and stored as checkpoint results.

The rate-limit result includes a `pending` Promise used for background analytics writes. Returning that Promise as part of the workflow step result would introduce a non-serializable value into durable workflow state.

The implementation therefore extracts only the fields required by subsequent workflow logic:

```ts
{
  success,
  limit,
  remaining,
  reset
}
```

The `pending` field is intentionally discarded before the step returns.

This preserves the information required to evaluate the limiter result without placing the background analytics Promise into the durable checkpoint.

A regression test explicitly verifies that the workflow step result does not contain `pending`.

---
## Webhook Identity & Proxy Assumptions
### 9. Client IP Resolution
The IP limiter uses `getClientIp()` to obtain a request's client IP from the `x-forwarded-for` and `x-real-ip` headers.

These headers are meaningful only when the deployment environment establishes a trusted proxy boundary.

The reverse proxy must sanitize or overwrite forwarding headers so that arbitrary client-supplied values cannot be used to manipulate the IP rate-limit key.

In a self-hosted deployment, blindly trusting these headers would weaken IP-based protection because a client could potentially supply different values across requests.

The current implementation therefore has an explicit deployment assumption: the public proxy boundary is responsible for establishing trustworthy client IP information.

This is an infrastructure requirement, not a guarantee provided by the rate limiter itself.

---
## Testing & Behavioral Regression Coverage
### 10. Security Boundary Tests
The Phase 6 tests verify not only the final response but also the ordering of security-sensitive operations.

The webhook tests cover:

- IP-limit rejection with HTTP `429` before organization database lookup.
- No organization rate-limit consumption when HMAC verification fails.
- Organization-limit rejection after successful HMAC verification.
- Successful webhook processing through the existing ingestion path.

These tests ensure that the order of operations remains part of the implementation contract.

### 11. Commander Approval Tests
Approval tests cover two distinct outcomes:

- An explicit approval rate-limit rejection prevents the request from proceeding.
- A Redis limiter failure does not independently remove the human-approval path.

The existing Commander authorization and stale-state protections remain part of the approval flow.

### 12. Blast-Radius Regression Tests
Execution tests cover both sides of the organization execution budget:

- When the budget is exceeded, the incident is escalated without executing the blocked action.
- When the budget allows execution, the normal simulated execution path continues.

The blocked-path tests verify that `action_executed` is not emitted, `blast_radius_exceeded` is recorded, and the workflow finishes with the expected reason.

A separate serialization test verifies that the durable workflow step result excludes the `pending` Promise.

---
## Developer Notes & Architecture Decisions
- **Multiple independent rate-limit boundaries.** Each limiter protects a distinct resource and is evaluated at the appropriate point in the request or workflow lifecycle.
- **Authenticate before charging the organization budget.** The organization-level webhook limiter runs after HMAC verification so that unsigned traffic cannot consume the organization's legitimate ingestion allowance.
- **Redis is a required dependency.** Runtime configuration must provide the Redis credentials needed by the rate-limit infrastructure.
- **Different failure policies for different boundaries.** Webhook ingestion and execution fail closed, while approval limiting preserves the human-approval path during Redis infrastructure failures.
- **Approval and execution remain separate decisions.** Commander authorization permits the proposed action to reach the execution boundary; the organization execution budget independently determines whether execution may proceed.
- **Escalation is an explicit workflow outcome.** An action blocked by the blast-radius limit is recorded as an escalation rather than being silently executed or reported as a successful remediation.
- **Durable workflow results remain serializable.** Background analytics Promises are excluded from workflow checkpoint results.
- **Proxy trust is an infrastructure responsibility.** IP-based limiting depends on correct handling of forwarding headers at the deployment boundary.
- **Behavioral tests protect ordering.** Regression coverage verifies that security checks execute in the correct sequence, not merely that the expected HTTP status or incident state eventually appears.

---
## Database and Migration Reliability
The Prisma migration history is tracked in version control, including `prisma/migrations/migration_lock.toml`. Database changes in this reliability work are delivered through versioned migrations rather than relying on undocumented manual edits.

The migrations added during this work:

- Restore the `ESCALATION_REQUIRED` enum value and the `runbook_chunk_embedding_idx` HNSW vector index.
- Add the `RunbookChunk` organization foreign-key constraint.
- Add the `Event(incidentId, createdAt)` index for chronological incident-event retrieval.
- Add the `EXECUTING` incident status used by the execution-claim lifecycle.

The Neon database was updated using `npx prisma migrate deploy`, and `npx prisma migrate status` reported that all eight migrations were applied and the database was up to date.

For a database setup, enable the `vector` extension before applying migrations if it is not already present. Use the tracked migration history as the source of truth; avoid using `prisma db push` as a substitute for applying the committed migration history in a migration-managed environment.

## Workflow Event Idempotency
Workflow-scoped deduplication keys are persisted through `Event.externalId`, using the unique `(orgId, externalId)` constraint to identify repeated logical events. Retries using the same stable key become no-ops, while unrelated database constraint errors are not swallowed.

Deduplication applies to events for which a stable key is supplied. It does not make every workflow step or external side effect exactly-once.

## Proposal-Bound Approval Integrity
Approval decisions are associated with the proposal they approve or reject. The workflow rejects approval data whose proposal identity does not match the active proposal and passes the stored proposal into the execution lifecycle rather than trusting replacement action data supplied by a caller.

Commander authorization and current incident-state checks remain mandatory. Proposal binding supplements those checks; it does not replace them.

## Atomic Execution Claims and Completion
Approved execution uses `AWAITING_APPROVAL → EXECUTING → RESOLVED` as a guarded state progression:

1. The execution-claim operation uses a conditional update scoped to the incident, organization, workflow run, and expected status.
2. The transition to `EXECUTING` and its proposal-specific claim event are committed together.
3. A superseded workflow does not continue through the simulated execution path.
4. The simulated `action_executed` record and transition to `RESOLVED` are committed in one database transaction.
5. A retry recognizes a previously recorded proposal-specific result instead of inserting a duplicate result.

**Important limitation:** the current executor records a simulated action outcome. These database transactions do not create exactly-once guarantees for real infrastructure or external provider side effects.

## Incident Lifecycle Transactions
Server-side status transitions are validated independently of the UI. Workflow-controlled statuses cannot be reached merely by calling the server action with a crafted payload.

Conditional lifecycle state updates and their associated audit events are written in the same database transaction. If the state transition fails or the event write fails, the transaction does not leave behind a partial state/event pair. Workflow timeout, rejection, approval-mismatch, and escalation paths use conditional updates to avoid overwriting a competing transition.

## CI and Validation
The GitHub Actions `verify` workflow performs a clean dependency install and runs Prisma schema validation/client generation, Next.js route type generation, TypeScript typechecking, linting, unit tests, and the production build.

Local validation on the reliability branch passed:

- `npx next typegen`
- `npx prisma generate`
- `npm run typecheck`
- `npm test` — latest local Phase 6 follow-up validation: 23 test files and 145 tests passed
- `npm run lint`
- `npm run build`

The GitHub Actions verify workflow has completed successfully on the pushed fix/phase-6-edge-cases follow-up branch. Both the local validation suite and hosted CI are green.

## Phase 6 Polish: Reliability, Security, and UI Recovery
The following hardening items were implemented after the original rate-limit and workflow-reliability work. The validation results below cover the follow-up branch: local checks passed and hosted GitHub Actions verify passed.

### SSE replay with equal timestamps
The incident stream uses a per-incident monotonic `streamSequence` cursor and orders replay by `streamSequence`, with `id` as a deterministic secondary key. Polling requests events with a sequence greater than the last-seen sequence rather than relying on `createdAt`, so events are not skipped solely because their timestamps are older than those already delivered. A PostgreSQL trigger allocates sequence values through a per-incident cursor row and serializes allocation until the inserting transaction completes. The route retains event-ID deduplication as a defensive measure. A regression test covers an event with an older `createdAt` but a higher sequence and terminal `workflow_finished` behavior. Per-connection database-polling cost remains; scaling work is planned for Phase 10.

### Current membership and role checks
The DAL verifies active-organization membership and role data from the database rather than relying exclusively on potentially stale session claims. Missing membership redirects to onboarding; a user whose current role does not satisfy a page's role requirement is directed to the dashboard appropriate for the current role. The shared application error UI no longer relies on `error.message` string matching or automatically signs users out as a recovery heuristic.

### Simulated prompt-injection demo flag
Synthetic adversarial injection content in simulated alerts is gated by `ENABLE_INJECTION_DEMO`, which defaults to `false`. The normal simulated-alert path uses a non-adversarial description. Enabling the flag is intended for controlled demos and testing, not as a claim that prompt-injection detection is complete.

### Runbook embedding recovery
If initial runbook indexing fails, the saved runbook remains available and the UI tells the user to use the **Re-index** action rather than creating a duplicate by re-saving. Re-indexing checks the current role and organization ownership, generates and validates embeddings before modifying stored chunks, then deletes and inserts chunks inside one database transaction. Embedding generation failure does not touch the existing index; an insert failure is rolled back by the database transaction. Re-index actions are available on Commander and Engineer runbook pages.

### Accessibility and error boundaries
The incident reasoning feed exposes sequential updates through `role="log"`, `aria-live="polite"`, and `aria-relevant="additions"`. A shared route-section recovery component supports route-level error boundaries for Commander, Engineer, and Observer. A separate shared incident-panel recovery component supports independent boundaries for Commander and Engineer reasoning and timeline panels. These boundaries provide retry UI and do not replace production error monitoring.

### Environment configuration
The unused `UPSTASH_WORKFLOW_URL` entry was removed from `.env.example`. `DIRECT_URL` remains used by `prisma.config.ts` and is documented in `.env.example`, CI, and the README. It is intentionally not part of the runtime `src/lib/env.ts` schema when consumed by Prisma CLI configuration rather than application runtime code.

### Deferred work
Public postmortem `sitemap.ts`, `robots.ts`, and Open Graph metadata remain deferred to Phase 11, when public postmortem routes exist. Real-Postgres concurrency and rollback verification, SQL-level tenant isolation tests, agent evaluations, and SSE load characterization are Phase 7 work; real external execution remains Phase 8 work.

---
## Implementation Checklist
### 1. Rate-Limit Infrastructure
- [x] Implement Redis-backed rate limiting.
- [x] Add the IP-level public webhook limiter.
- [x] Add the organization-level ingestion limiter.
- [x] Add the per-user Commander approval limiter.
- [x] Add the organization-level execution limiter.
- [x] Require Redis configuration in `src/lib/env.ts`.

### 2. Webhook Ingestion
- [x] Apply the IP limiter before organization database lookup.
- [x] Reject requests exceeding the IP budget with HTTP `429`.
- [x] Perform HMAC verification before consuming the organization budget.
- [x] Apply the organization limiter after successful signature verification.
- [x] Reject requests exceeding the organization budget with HTTP `429`.
- [x] Preserve the existing payload validation and ingestion flow.
- [x] Test limiter ordering and the absence of organization-bucket consumption on HMAC failure.

### 3. Commander Approval
- [x] Apply the per-user approval limiter.
- [x] Reject explicit approval rate-limit denials.
- [x] Preserve the human-approval path when the Redis limiter fails.
- [x] Retain database-backed Commander authorization.
- [x] Retain the `AWAITING_APPROVAL` stale-state guard.
- [x] Test explicit rejection and Redis-failure behavior.

### 4. Execution Blast-Radius Control
- [x] Apply the organization execution limiter after approval and immediately before simulated execution.
- [x] Prevent the blocked execution path from emitting `action_executed`.
- [x] Introduce the `ESCALATION_REQUIRED` incident state.
- [x] Record `blast_radius_exceeded`.
- [x] Emit terminal `workflow_finished` with reason `blast_radius_exceeded`.
- [x] Preserve successful execution when the budget permits it.
- [x] Exclude the limiter's `pending` Promise from durable workflow results.
- [x] Test blocked and successful execution paths.

### 5. Documentation & Deployment Assumptions
- [x] Document the configured rate-limit budgets.
- [x] Document the approval fail-open and ingestion/execution fail-closed distinction.
- [x] Document the proxy-header trust assumption.
- [x] Document the workflow serialization constraint.
- [x] Record deferred work explicitly: public postmortem metadata in Phase 11 and real-Postgres verification in Phase 7.

### 6. Database, Workflow, Approval and Lifecycle Reliability
- [x] Track Prisma migration history and migration lock file in version control.
- [x] Restore the required HNSW vector index and `ESCALATION_REQUIRED` status value.
- [x] Add the `RunbookChunk` organization foreign-key constraint and chronological `Event` index.
- [x] Add the `EXECUTING` status for atomic approved-execution claims.
- [x] Deduplicate supported workflow events using stable workflow-scoped keys.
- [x] Bind approval decisions to the active proposal identity.
- [x] Persist execution claims and simulated completion outcomes transactionally.
- [x] Enforce incident status transitions on the server.
- [x] Commit conditional lifecycle transitions and their audit events in the same transaction.
- [x] Add and verify the GitHub Actions CI pipeline.
- [x] Pass local typecheck, test, lint, and whitespace validation for the latest polish changes.
- [x] Run the production build against the completed follow-up working tree; `npm run build` passed locally.
- [x] Confirm full CI on the updated branch; GitHub Actions verify passed on fix/phase-6-edge-cases.
- [x] Complete the Phase 6 accessibility and error-boundary work described in the polish section below.
- [x] Complete the listed SSE replay, runbook re-index, stale-role handling, injection-demo gating, and environment-cleanup items.
- [~] Defer public postmortem metadata to Phase 11, when postmortem pages exist.

---
## Definition of Done
- [x] Public webhook traffic is rate-limited before organization database lookup.
- [x] Organization ingestion limits are applied only after successful HMAC verification.
- [x] Commander approval requests are rate-limited without making Redis availability the sole dependency of the human-approval path.
- [x] Organization-level execution limits are enforced after approval and before simulated execution.
- [x] Exceeded execution budgets result in explicit escalation rather than execution.
- [x] Blocked execution emits no `action_executed` event.
- [x] Escalation and terminal workflow events identify the reason for the blocked execution.
- [x] Durable workflow step results contain only the serializable fields required by subsequent steps.
- [x] Regression tests cover limiter ordering, approval failure semantics, execution outcomes, and workflow serialization.

Additional Phase 6 polish outcomes:

- [x] SSE replay/polling uses monotonic per-incident `streamSequence` and event-ID deduplication to avoid timestamp-based skips and duplicate delivery.
- [x] Current organization membership and role are re-checked through the DAL for protected route access.
- [x] Simulated prompt-injection payloads are disabled by default and guarded by `ENABLE_INJECTION_DEMO`.
- [x] Runbooks can be re-indexed without creating duplicate runbook records; embedding generation precedes transactional chunk replacement.
- [x] The incident reasoning feed exposes accessible live updates.
- [x] Commander, Engineer, and Observer route sections have dedicated error boundaries; Commander and Engineer incident reasoning/timeline panels also have dedicated boundaries.
- [x] `UPSTASH_WORKFLOW_URL` was removed from `.env.example`, and `DIRECT_URL` usage was audited across Prisma config, CI, and docs.
- [~] Public postmortem sitemap, robots, and Open Graph metadata are deferred to Phase 11.

Additional reliability outcomes:

- [x] Migration history is version-controlled and the configured Neon database reports no pending migrations.
- [x] Workflow events can use stable deduplication identities across supported retries.
- [x] Approval decisions are bound to the proposal identity.
- [x] Execution claims and simulated completion outcomes are transactionally guarded.
- [x] Server-side status-transition validation and transactional lifecycle audit writes are covered by tests.
- [x] GitHub Actions `verify` completes successfully.

---
## Known Limitations & Closure Status
The rate-limiting, blast-radius, database, workflow, approval, lifecycle-reliability, accessibility, error-boundary, and other Phase 6 polish work described here is implemented and covered by local validation. The follow-up branch has been pushed and hosted CI has passed. Public postmortem metadata is deferred to Phase 11 by design.

### Proxy Configuration
IP-based rate limiting depends on the deployment's trusted-proxy configuration. Self-hosted deployments must ensure forwarding headers cannot be freely spoofed by external clients.

### Redis Availability
The approval limiter deliberately preserves the approval path when Redis fails. During that failure window, approval requests do not receive the additional rate-limit protection, although the existing authorization and incident-state checks remain mandatory.

Webhook ingestion and execution instead fail closed when their required limiter cannot operate.

### Broader Hardening Work
- Accessibility: implemented using `role="log"`, `aria-live="polite"`, and `aria-relevant="additions"` on the reasoning feed.
- Error boundaries: implemented for Commander, Engineer, and Observer route sections, plus Commander and Engineer incident reasoning and timeline panels.
- Public postmortem metadata: intentionally deferred to Phase 11 because the public postmortem pages do not exist yet.

Local validation passed: 145 tests across 23 test files, TypeScript typechecking, ESLint, Prisma schema validation, and `npm run build`.

---
## Final Architectural Outcome
Phase 6 adds resource-level controls to Sentinel without changing the core trust model established in earlier phases.

Public ingestion is constrained before expensive database work, organization budgets are protected from unsigned webhook traffic, Commander approval remains explicitly human-authorized, and remediation execution is constrained by an organization-level budget.

When execution cannot proceed, Sentinel records an explicit escalation and terminates the workflow with a machine-readable reason rather than silently executing the action.

The resulting architecture preserves the distinction between **authentication, authorization, rate limiting, and execution control**. Each mechanism has a separate responsibility, and none is treated as a substitute for the others.

**Deferred by design:** postmortem sitemap, robots, and Open Graph metadata in Phase 11. Real-Postgres concurrency/rollback verification and agent/load evaluations are Phase 7; real external execution is Phase 8.
