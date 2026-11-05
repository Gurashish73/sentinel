# Sentinel: Development Phases & Roadmap

This document outlines the architecture plan for building Sentinel. Each phase is designed to end in a functional, demoable milestone so the application remains stable throughout development.

## Phase 0 — Foundations

- **Learn:** App Router structure, environment validation, Prisma schema design, and Auth.js v5.
- **Build:** Repository scaffold, Prisma schema (Organization, User, Membership, Incident, Event, Runbook), authentication with role-based sessions, root layout, and Commander/Engineer/Observer route groups.
- **Checklist Coverage:** 01, 03, 04, 15

## Phase 1 — Core CRUD

- **Learn:** Server Components, Server Actions, and `revalidateTag`.
- **Build:** Server-rendered incident list/detail, manual incident creation, runbook CRUD, and organization settings with Zod validation and server-side authorization.
- **Checklist Coverage:** 02, 05, 06, 07, 08

## Phase 2 — Ingestion & Event Store

- **Learn:** Route Handlers, middleware, webhook HMAC verification, and event sourcing.
- **Build:** Webhook ingestion, immutable Event records, duplicate-delivery handling, and organization/role scoping.
- **Checklist Coverage:** 09, 11

## Phase 3 — Durable Agent Orchestration

- **Learn:** Upstash Workflow, durable steps, idempotency keys, and tool-calling loop design.
- **Build:** Triage → Diagnosis → Remediation workflow with a human-approval gate through `waitForEvent`.
- **Checklist Coverage:** 16, 18 (idempotency and duplicate-webhook handling)

## Phase 4 — Real-Time UI

- **Learn:** Server-Sent Events, typed event protocols, Suspense, and optimistic updates.
- **Build:** Live reasoning feed, approval/rejection flow, and incident detail pages using Parallel and Intercepting Routes.
- **Checklist Coverage:** 10, 12, 13, 19

## Phase 5 — AI Intelligence (RAG)

- **Learn:** Chunking strategy, embeddings, and pgvector similarity search.
- **Build:** Runbook upload → chunking → embedding pipeline; Diagnosis retrieves relevant, organization-scoped runbook passages.
- **Checklist Coverage:** 16 (continued)

## Phase 6 — Hardening, Reliability & Polish

- **Learn:** Redis-backed rate limiting, blast-radius controls, workflow idempotency, transaction-safe state transitions, workflow-attempt fencing, database-backed authorization recovery, accessible real-time interfaces, and automated validation.
- **Build:** Webhook and Commander approval rate limits, organization-level execution budgets, reproducible Prisma migrations, proposal-bound approvals, atomic execution claims, transactional incident lifecycle events, guarded workflow retries, and CI validation.
- **Additional hardening:** Monotonic per-incident SSE sequencing backed by a PostgreSQL trigger, database-backed organization membership and role recovery, stale workflow-attempt protection, shared retry-eligibility logic, client-side SSE visibility recovery, runbook re-index recovery, accessible reasoning-feed updates, and independent error boundaries for Commander, Engineer, and Observer incident panels.
- **Critical-severity triage guard:** `CRITICAL` incidents bypass the LLM `SKIP` verdict and proceed to diagnosis after the existing injection scan. This does not bypass human approval or the organization-level execution limit.
- **SSE reconnect and replay:** Each event carries its `streamSequence` as its SSE ID. Reconnecting clients resume through `Last-Event-ID`, and the route recognizes terminal completion for the current workflow run across reconnects.
- **Investigation-start protection:** Added an organization-scoped limit of 30 investigation starts per hour. All new workflow-start paths use the same limiter, including manual incident creation and Commander retries. The limiter is checked once per logical start and fails closed when Redis is unavailable.
- **Environment configuration:** Removed the unused `UPSTASH_WORKFLOW_URL` example entry. Audited `DIRECT_URL`: Prisma CLI configuration uses it for migration/database operations, and it remains documented in `.env.example`, CI, and the README. It is intentionally separate from the runtime environment schema in `src/lib/env.ts`.
- **Deferred to Phase 11:** Public postmortem metadata (`sitemap.ts`, `robots.ts`, Open Graph images). Postmortem pages do not exist yet, so this work cannot be completed meaningfully here.
- **Detailed record:** [Phase 6.md](./Phase%206.md)

### Phase 6 Implementation Checklist

**Rate limiting and workflow protection**

- [x] Webhook IP and organization rate limiting.
- [x] Commander approval rate limiting and documented Redis-failure policy.
- [x] Organization-level execution blast-radius limit and explicit escalation.
- [x] Organization-level investigation-start rate limiting (30 starts/hour).
- [x] Apply investigation-start limits across new workflow-start paths, including manual incident creation and Commander retries.
- [x] Fail closed when the investigation-start limiter cannot establish the organization's budget.

**Workflow, approval, and lifecycle reliability**

- [x] Prisma migration history tracked and migrations applied to the isolated Neon test database.
- [x] Workflow event deduplication for supported retry paths.
- [x] Proposal-bound approval decisions.
- [x] Atomic approved-execution claims and transactional simulated execution outcome.
- [x] Server-side incident lifecycle validation and transactional lifecycle events.
- [x] Add workflow-attempt token fencing to prevent stale or superseded attempts from taking ownership.
- [x] Implement guarded retry reservation, rollback, and attempt-token rotation.
- [x] Add shared retry-eligibility logic for supported workflow completion outcomes.
- [x] Record operator retry audit events and report concurrent changes without claiming a false rollback.
- [x] Critical-severity incidents bypass the LLM `SKIP` verdict and proceed to diagnosis while retaining all human-approval and execution controls.

**Streaming, authorization, and UI recovery**

- [x] GitHub Actions CI pipeline added and a successful run verified.
- [x] Accessible live announcements on the reasoning feed using `role="log"`, `aria-live="polite"`, and `aria-relevant="additions"`.
- [x] Error boundaries for Commander, Engineer, and Observer route segments.
- [x] Independent error boundaries for Commander, Engineer, and Observer incident reasoning and timeline panels.
- [x] SSE replay/polling uses the per-incident `streamSequence` cursor and event-ID deduplication to prevent timestamp-based skips and duplicate delivery.
- [x] SSE reconnect supports `Last-Event-ID` replay and current-workflow completion recognition.
- [x] Client streaming pauses while the browser tab is hidden and recovers when it becomes visible, without restarting after workflow completion.
- [x] Recover active organization and current role using database-backed membership rather than relying exclusively on potentially stale session claims.
- [x] Runbook re-index action added for Commander and Engineer; embedding generation precedes transactional index replacement.
- [x] Removed brittle `error.message` string matching and automatic sign-out from the shared application error boundary in favor of generic recovery UI.

**Configuration and test infrastructure**

- [x] Removed the unused `UPSTASH_WORKFLOW_URL` entry from `.env.example`.
- [x] Audited `DIRECT_URL` usage across Prisma configuration, CI, `.env.example`, and README.
- [x] Gated simulated prompt-injection payloads behind `ENABLE_INJECTION_DEMO`, disabled by default.
- [x] Separate unit and integration Vitest configurations.
- [x] Added a dedicated `npm run test:integration` command.
- [x] Created an isolated Neon PostgreSQL test database (`sentinel_test`).
- [x] Applied all 10 Prisma migrations to the isolated test database.
- [x] Added initial PostgreSQL integration coverage for event sequence allocation, workflow claim predicates, stale-attempt fencing, and concurrent failure transaction behavior.
- [~] Public postmortem metadata deferred to Phase 11.

**Phase 6 validation results**

The latest reported local validation run passed:

- [x] `npm test` — **200 tests passed across 29 test files**.
- [x] `npm run test:integration` — **4 PostgreSQL integration tests passed** against the dedicated Neon `sentinel_test` database.
- [x] `npm run typecheck` — passed.
- [x] `npm run lint` — passed.
- [x] `npm run build` — passed; Next.js generated 12/12 static pages.
- [x] `git diff --check` — passed.

All 10 Prisma migrations were successfully applied to the isolated Neon test database.

**Integration-test scope and limitations:**

The initial PostgreSQL suite covers:

1. Concurrent event insertion using the actual PostgreSQL sequence trigger, verifying unique and contiguous event sequences.
2. Workflow claim contention using the database claim predicate directly.
3. Stale-attempt rejection using the database conditional-update predicate directly.
4. Concurrent failure-callback transaction behavior by reproducing the database transaction logic.

The claim and stale-attempt tests do not invoke the complete production workflow route. The failure-callback integration test does not invoke the actual Upstash `failureFunction` handler. These tests establish initial database-level evidence but do not constitute complete end-to-end proof of all application concurrency and transaction guarantees.

**Phase 7 verification remains necessary.** Production application-path concurrency, transaction rollback under fault injection, SQL-level tenant isolation, and broader idempotency verification remain outstanding.

## Phase 7 — Verification & Test Rigor

**Status: In progress.** The initial local PostgreSQL integration-testing foundation was established during Phase 6. The remaining Phase 7 work extends this foundation into broader production-path verification and automated CI coverage.

- **Learn:** Integration testing against a real database, concurrency testing, fault injection, and evaluating non-deterministic systems.
- **Already established:**
  - Separate unit and integration Vitest configurations.
  - A dedicated `npm run test:integration` command.
  - An isolated Neon PostgreSQL test database with the committed Prisma migrations applied.
  - Initial integration tests covering event sequence allocation, claim contention, stale-attempt fencing, and concurrent failure transaction behavior.
- **Remaining work:**
  - A CI integration job using an ephemeral `pgvector/pgvector` service container and migrations applied from an empty database.
  - Production application-path concurrency and rollback testing for execution claims, approval/rejection, completion, and competing lifecycle transitions.
  - Fault-injection tests verifying transaction rollback when associated event or audit writes fail.
  - Persisted idempotency and replay verification, including unrelated unique-constraint failures.
  - SQL-level tenant isolation tests across incident, event, runbook, and vector retrieval paths.
  - An agent evaluation harness using golden incidents and a prompt-injection corpus.
  - SSE load characterization to measure the limits of the current polling architecture.
- **Exit criterion:** The targeted concurrency, atomicity, idempotency, and tenant-isolation guarantees are verified against real PostgreSQL through the relevant application paths. Direct SQL predicate tests alone do not count as complete verification of production application behavior.
- **Detailed record:** [Phase 7.md](./Phase%207.md)

## Phase 8 — Real Execution Layer

- **Learn:** Typed action catalogs, executor interfaces, idempotency keys for external side effects, and verification-driven state transitions.
- **Build:**
  - A closed **action catalog** (`restart_service`, `scale_deployment`, `rollback_release`, ...) with Zod-validated parameters. The model selects from the catalog and never invents commands.
  - An **executor interface** with `dryRun()`, `execute()`, `verify()`, and `rollback()`. The current simulated executor becomes one implementation.
  - One real, sandboxed executor (for example, a GitHub Actions `workflow_dispatch` using the existing encrypted `githubToken`).
  - Provider-side idempotency keys, since a database transaction cannot provide exactly-once behavior for external effects.
  - A post-execution verification step: `RESOLVED` only if health checks pass, otherwise `ESCALATION_REQUIRED`.
  - A risk-based approval policy (for example, high risk requires two distinct Commanders). Human approval remains the default.
- **Exit criterion:** One approved remediation causes a verified, idempotent change in a real sandbox environment.

## Phase 9 — Real Data & Tool Calling

- **Learn:** Provider abstraction, bounded tool-calling loops, hybrid retrieval, and citation grounding.
- **Build:**
  - A log-provider interface with one real backend (Loki, CloudWatch, or Datadog) replacing the mock.
  - Diagnosis as a bounded tool-calling loop with step and token budgets instead of a fixed fetch-then-summarize.
  - Webhook adapters for GitHub, Sentry, and PagerDuty that normalize provider payloads.
  - Hybrid retrieval (keyword + vector) with a reranker, and citation validation by chunk ID rather than title substring matching.

## Phase 10 — Observability & Scale

- **Learn:** Structured logging, distributed tracing, cost accounting for LLM usage, and fan-out streaming.
- **Build:**
  - Structured logs with correlation IDs (incident ID, workflow run ID).
  - OpenTelemetry traces across webhook → workflow step → LLM call.
  - Token and cost tracking per organization and per agent stage, plus a per-organization LLM budget limiter.
  - Replace per-connection database polling in the SSE route with Redis pub/sub or a single change-feed poller fanned out to connections.
  - An internal workflow-health view for stuck workflows, trigger failures, and p95 time to proposal.
- **Exit criterion:** Beat the SSE connection ceiling recorded in Phase 7.

## Phase 11 — Product Surface

- **Build (pick by audience):**
  - Member invites and role management (today a user can only create an organization, not join one).
  - Organization switching (the session currently carries a single `activeOrgId`).
  - Auto-generated postmortems from the event store, with shareable pages, `sitemap.ts`, `robots.ts`, and Open Graph images (moved from Phase 6).
  - Slack/email notifications for `AWAITING_APPROVAL`, with approve/reject links.
  - Audit log export and runbook versioning.

## Project Status Tracker

- [x] **Phase 0:** Foundations
- [x] **Phase 1:** Core CRUD
- [x] **Phase 2:** Ingestion & Event Store
- [x] **Phase 3:** Durable Agent Orchestration
- [x] **Phase 4:** Real-Time UI
- [x] **Phase 5:** AI Intelligence (RAG)
- [x] **Phase 6:** Hardening, Reliability & Polish
- [ ] **Phase 7:** Verification & Test Rigor
- [ ] **Phase 8:** Real Execution Layer
- [ ] **Phase 9:** Real Data & Tool Calling
- [ ] **Phase 10:** Observability & Scale
- [ ] **Phase 11:** Product Surface

Public postmortem metadata remains intentionally deferred to Phase 11. Phase 6 is complete, including the initial real-PostgreSQL integration-testing foundation established against an isolated Neon test database. Phase 7 will extend this foundation with production-path concurrency verification, transaction rollback tests, SQL-level tenant-isolation checks, agent evaluations, and SSE load characterization. The PostgreSQL event-sequence trigger already has automated integration coverage against Neon.
