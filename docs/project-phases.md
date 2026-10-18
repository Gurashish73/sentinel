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

- **Learn:** Redis-backed rate limiting, blast-radius controls, workflow idempotency, transaction-safe state transitions, accessible real-time interfaces, and automated CI validation.
- **Build:** Webhook and Commander approval rate limits, organization-level execution budgets, reproducible Prisma migrations, proposal-bound approvals, atomic execution claims, transactional incident lifecycle events, and CI validation.
- **Additional hardening:** Same-timestamp SSE replay handling, current database-backed membership and role checks, a demo-only prompt-injection flag, runbook re-index recovery, accessible reasoning-feed updates, and independent error boundaries.
- **Environment configuration:** Removed the unused `UPSTASH_WORKFLOW_URL` example entry. Audited `DIRECT_URL`: Prisma CLI configuration uses it for migration/database operations, and it remains documented in `.env.example`, CI, and the README. It is intentionally separate from the runtime environment schema in `src/lib/env.ts`.
- **Deferred to Phase 11:** Public postmortem metadata (`sitemap.ts`, `robots.ts`, Open Graph images). Postmortem pages do not exist yet, so this work cannot be completed meaningfully here.
- **Detailed record:** [Phase 6.md](./Phase%206.md)
- **Status:** Implementation and automated validation are complete on `fix/phase-6-polish`. Final PR review and merge remain outstanding.

### Phase 6 Implementation Checklist

- [x] Webhook IP and organization rate limiting.
- [x] Commander approval rate limiting and documented Redis-failure policy.
- [x] Organization-level execution blast-radius limit and explicit escalation.
- [x] Prisma migration history tracked and database migrations verified.
- [x] Workflow event deduplication for supported retry paths.
- [x] Proposal-bound approval decisions.
- [x] Atomic approved-execution claims and transactional simulated execution outcome.
- [x] Server-side incident status-transition validation and transactional lifecycle events.
- [x] GitHub Actions CI pipeline added and a successful run verified.
- [x] Accessible live announcements on the reasoning feed using `role="log"`, `aria-live="polite"`, and `aria-relevant="additions"`.
- [x] Error boundaries for Commander, Engineer, and Observer route segments.
- [x] Independent error boundaries for Commander and Engineer incident reasoning and timeline panels.
- [x] SSE replay/polling handles late-arriving events with identical timestamps while preventing duplicate delivery.
- [x] Runbook re-index action added for Commander and Engineer; embedding generation precedes transactional index replacement.
- [x] Removed brittle `error.message` string matching and automatic sign-out from the shared application error boundary in favor of generic recovery UI.
- [x] Removed the unused `UPSTASH_WORKFLOW_URL` entry from `.env.example`.
- [x] Audited `DIRECT_URL` usage across Prisma configuration, CI, `.env.example`, and README.
- [x] Gated simulated prompt-injection payloads behind `ENABLE_INJECTION_DEMO`, disabled by default.
- [~] Public postmortem metadata deferred to Phase 11.

**Phase 6 validation results**

- [x] Full Vitest suite: 141 tests passed across 22 test files.
- [x] TypeScript typecheck passed.
- [x] ESLint passed.

These tests establish the current automated regression baseline. Real-Postgres concurrency and transaction verification remains part of Phase 7.

## Phase 7 — Verification & Test Rigor

- **Learn:** Integration testing against a real database, concurrency testing, fault injection, and evaluating non-deterministic systems.
- **Build:**
  - A real-Postgres integration suite in CI using a `pgvector/pgvector` service container, with migrations applied from an empty database.
  - Concurrency and rollback tests covering the atomicity and idempotency claims from Phases 2–6.
  - SQL-level tenant isolation tests.
  - An agent evaluation harness using golden incidents and a prompt-injection corpus.
  - An SSE load characterization to measure the limits of the current polling architecture.
- **Exit criterion:** Every "atomic / idempotent / first-writer-wins" claim in the docs is backed by a test against a real database.
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
- [x] **Phase 6:** Hardening, Reliability & Polish — implementation complete; PR review and merge pending.
- [ ] **Phase 7:** Verification & Test Rigor
- [ ] **Phase 8:** Real Execution Layer
- [ ] **Phase 9:** Real Data & Tool Calling
- [ ] **Phase 10:** Observability & Scale
- [ ] **Phase 11:** Product Surface

### Phase 6 Closure Note

Phase 6 implementation and automated validation are complete on `fix/phase-6-polish`. The current baseline is 141 passing tests across 22 test files, with TypeScript, ESLint, and whitespace validation passing.

Phase 6 should be considered fully closed once the existing PR has passed its CI/review requirements and is merged into `main`. Public postmortem metadata remains intentionally deferred to Phase 11. Real-Postgres concurrency and transaction tests remain Phase 7 work.
