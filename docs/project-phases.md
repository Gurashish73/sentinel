# Sentinel: Development Phases & Roadmap

This document outlines the seven-phase architecture plan for building Sentinel. Each phase is designed to end in a functional, demoable milestone so the application remains stable throughout development.

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

- **Learn:** Redis-backed rate limiting, blast-radius controls, workflow idempotency, transaction-safe state transitions, and automated CI validation.
- **Build:** Rate limits for webhook ingestion and Commander approval, organization-level execution budgets, reproducible Prisma migrations, proposal-bound approvals, atomic execution claims, transactional incident lifecycle events, and CI validation.
- **Still outstanding:** Accessibility improvements (`aria-live`), error boundaries per application segment, and public postmortem metadata (`sitemap.ts`, `robots.ts`, Open Graph images).
- **Detailed record:** [Phase 6.md](./Phase%206.md)
- **Status:** Core reliability work and CI validation are implemented; Phase 6 remains in progress while the remaining polish items are outstanding.

## Project Status Tracker

- [x] **Phase 0:** Foundations
- [x] **Phase 1:** Core CRUD
- [x] **Phase 2:** Ingestion & Event Store
- [x] **Phase 3:** Durable Agent Orchestration
- [x] **Phase 4:** Real-Time UI
- [x] **Phase 5:** AI Intelligence (RAG)
- [ ] **Phase 6:** Hardening, Reliability & Polish
  - [x] Webhook IP and organization rate limiting.
  - [x] Commander approval rate limiting and documented Redis-failure policy.
  - [x] Organization-level execution blast-radius limit and explicit escalation.
  - [x] Prisma migration history tracked and database migrations verified.
  - [x] Workflow event deduplication for supported retry paths.
  - [x] Proposal-bound approval decisions.
  - [x] Atomic approved-execution claims and transactional simulated execution outcome.
  - [x] Server-side incident status-transition validation and transactional lifecycle events.
  - [x] GitHub Actions CI pipeline added and a successful run verified.
  - [ ] Accessibility improvements (`aria-live`).
  - [ ] Error boundaries per application segment.
  - [ ] Public postmortem metadata (`sitemap.ts`, `robots.ts`, Open Graph images).

Phase 6 is deliberately not marked complete until the remaining accessibility, error-boundary, and public postmortem work is implemented and verified.
