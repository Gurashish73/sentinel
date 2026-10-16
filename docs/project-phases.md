# Sentinel: Development Phases & Roadmap

This document outlines the seven-phase architecture plan for building Sentinel. Each phase is designed to end in a fully functional, demoable milestone to ensure the application remains stable throughout development.

## Phase 0 — Foundations

* **Learn:** App Router structure, env validation, Prisma schema design, Auth.js v5.
* **Build:** Repository scaffold, Prisma schema (Org, User, Membership, Incident, Event, Runbook), Auth.js with role-based sessions, root layout, and `(commander)`/`(engineer)`/`(observer)` route groups.
* **Checklist Coverage:** 01, 03, 04, 15

## Phase 1 — Core CRUD

* **Learn:** Server Components as default, Server Actions, `revalidateTag`.
* **Build:** Incident list/detail (server-rendered), manual incident creation, runbook CRUD, org settings — all via Server Actions with Zod validation.
* **Checklist Coverage:** 02, 05, 06, 07, 08

## Phase 2 — Ingestion & Event Store

* **Learn:** Route Handlers, middleware, webhook HMAC verification, event sourcing.
* **Build:** Webhook endpoint that simulates an incoming alert, immutable Event table as source of truth, middleware enforcing org+role scoping.
* **Checklist Coverage:** 09, 11

## Phase 3 — Durable Agent Orchestration (The Core)

* **Learn:** Upstash Workflow, durable steps, idempotency keys, tool-calling loop design.
* **Build:** Triage Agent → Diagnosis Agent (with mocked "fetch logs" tool) → Remediation Agent, each as a workflow step; approval gate via `waitForEvent`.
* **Checklist Coverage:** 16, 18 (idempotency, duplicate-webhook handling)

## Phase 4 — Real-Time UI

* **Learn:** SSE via Route Handlers, typed event protocol, Suspense, `useOptimistic`.
* **Build:** Live reasoning feed, approve/reject with instant optimistic feedback, incident page split into `@timeline` / `@reasoning` / `@affectedServices` parallel routes.
* **Checklist Coverage:** 10, 12, 13 (past-incident detail as an intercepted modal), 19

## Phase 5 — AI Intelligence (RAG)

* **Learn:** Chunking strategy, embeddings, pgvector similarity search.
* **Build:** Runbook upload → chunk → embed pipeline; Diagnosis Agent retrieves and cites relevant runbook passages.
* **Checklist Coverage:** 16 (continued)

## Phase 6 — Hardening & Polish

* **Learn:** `aria-live`, Redis sliding-window rate limits, dynamic OG images.
* **Build:** Accessible live feed, webhook ingestion and Commander approval rate limits, post-approval execution blast-radius control, error boundaries per segment, `sitemap.ts`/`robots.ts`/OG images for public postmortem pages, CI pipeline.
* **Checklist Coverage:** 14, 17, 20
* **Status:** Webhook ingestion, organization, and Commander approval rate limiting, plus organization-level execution blast-radius control, implemented with regression tests — see `docs/Phase 6.md`. Accessibility, error boundaries, public postmortem metadata, and CI remain outstanding.

## Project Status Tracker

* [x] **Phase 0:** Foundations
* [x] **Phase 1:** Core CRUD
* [x] **Phase 2:** Ingestion & Event Store
* [x] **Phase 3:** Durable Agent Orchestration (The Core)
* [x] **Phase 4:** Real-Time UI
* [x] **Phase 5:** AI Intelligence (RAG)
* [ ] **Phase 6:** Hardening & Polish
   * [x] Rate Limits & Blast-Radius Control
   * [ ] Accessibility improvements (`aria-live`)
   * [ ] Error boundaries per application segment
   * [ ] Public postmortem metadata (`sitemap.ts`, `robots.ts`, OG images)
   * [ ] CI pipeline implementation and verification