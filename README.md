<div align="center">

# 🛡️ Sentinel OS

### Autonomous Incident Response, Gated Behind Human Approval

Sentinel receives production alerts, investigates them through a durable multi-agent workflow, streams its reasoning in real time, and proposes a remediation — but **no action is ever executed without explicit human approval.**

[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?style=flat&logo=next.js)](https://nextjs.org/)
[![Prisma 7](https://img.shields.io/badge/Prisma-7-1B222D?style=flat&logo=prisma)](https://prisma.io/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Neon-336791?style=flat&logo=postgresql)](https://neon.tech/)
[![Tailwind v4](https://img.shields.io/badge/Tailwind-v4-06B6D4?style=flat&logo=tailwindcss)](https://tailwindcss.com/)
[![Upstash](https://img.shields.io/badge/Upstash-Workflow-00E9A3?style=flat)](https://upstash.com/)
[![Upstash Redis](https://img.shields.io/badge/Rate_Limiting-Upstash_Redis-00E9A3?style=flat)](https://upstash.com/)

</div>

---

<div align="center">

![Sentinel OS demo](./docs/assets/demo.webp)

<p align="center"><em>
Simulate an alert → watch the agent investigate in real time → approve the proposed remediation → the paused durable workflow resumes automatically.
</em></p>

</div>

## Why Sentinel?

Most "AI DevOps" tools are a chatbot wrapper: one API call, a summary, done. If the
process crashes mid-summary, you start over. If two webhooks arrive for the same
incident, you get two responses. Nothing about that is durable, and nothing about it
is safe to point at production.

Sentinel is built differently — as a **durable, resumable workflow**, not a single
LLM call:

- **Durable investigation.** Upstash Workflow checkpoints each step and resumes from the last completed one after a crashed worker, a network blip, or a retryable failure — not from scratch.
- **Idempotent ingestion.** Database constraints deduplicate repeated webhook deliveries, so a retried webhook never creates a second incident.
- **Tool-assisted diagnosis.** Agents reason over incident context, a mocked log tool, and runbook passages retrieved through semantic search — a real `reason → act → observe → reason again` loop, not one-shot summarization.
- **Human authorization.** The workflow pauses at a durable approval gate. Not a UI convention — an architectural constraint. An `action_approved` event has to exist in the database before an action can run, full stop.
- **Execution guardrails.** Redis-backed rate limits constrain public webhook traffic, organization ingestion, Commander approval requests, and post-approval execution volume.
- **Workflow and lifecycle reliability.** Stable event keys reduce duplicate logical events on supported retry paths; approvals are bound to their proposal; execution claims are atomic; and incident state transitions are validated on the server and recorded transactionally with their audit events.

> **Scope note:** Remediation execution is currently simulated. The approval gate and blast-radius controls demonstrate Sentinel's safety boundaries; they do not mean Sentinel is already applying arbitrary changes to production infrastructure.

## Architecture

<div align="center">

<img src="./docs/assets/workflow.png" alt="Sentinel high-level architecture" width="700" />

<br /><br />

<p align="center">
<i>High-level architecture showing how request handling transitions into durable workflow orchestration. The detailed execution flow is shown below.</i>
</p>

</div>

```mermaid
flowchart TD
    A[Webhook: GitHub / Sentry / Datadog] --> B[IP Rate Limiter]
    B --> C[Organization Lookup]
    C --> D[HMAC Verification]
    D --> E[Organization Rate Limiter]
    E --> F[Payload Validation + ingestAlert]
    F -->|idempotent, ACID transaction| G[(Incident + Event Store)]
    G -->|triggers, with retry + backoff| H[Upstash Workflow]

    H --> I[Triage Agent]
    I -->|INVESTIGATE| J[Diagnosis Agent]
    I -->|SKIP| N[Workflow Finished]
    J -->|logs + runbook context| K[Remediation Agent]
    K -->|proposes action| L{Human Approval Gate}

    L -->|waitForEvent, pauses indefinitely| M[Commander Decision]
    M -->|rejected| O[Return to OPEN]
    M -->|approved| P[Organization Execution Limiter]
    P -->|budget available| X[Atomic EXECUTING Claim]
    X -->|claimed| Q[Simulated Execution]
    X -->|superseded| N
    P -->|budget exceeded| R[ESCALATION_REQUIRED]

    Q --> S[action_executed]
    R --> T[blast_radius_exceeded]
    S --> U[workflow_finished]
    T --> U
    O --> U

    G -.->|SSE, polling-based| V[IncidentStreamProvider]
    V --> W[Live Timeline + Reasoning UI]
    M -.->|notify| H
```

After the incident is persisted, Sentinel triggers an Upstash Workflow. Its agent pipeline — Triage, Diagnosis, Remediation, and the approval wait — runs as **durable, checkpointed steps**, so a completed stage is reused rather than re-run if the workflow retries or resumes.

The Human Approval Gate is a **real pause**: the workflow sits idle in the cloud, sometimes for hours, until a Commander acts.

Webhook requests are rate-limited by IP **before** organization lookup, so an unauthenticated caller can't burn a database query per guess. The organization-level limiter runs only **after** HMAC verification, so unsigned traffic can't consume a legitimate organization's ingestion budget.

After approval, a separate organization-level execution limiter runs immediately before execution. An atomic execution claim then coordinates competing workflow deliveries. If the budget is exceeded, Sentinel records an explicit escalation rather than executing the blocked action.

## The Agent Pipeline

| Agent | Job | Implementation |
| --- | --- | --- |
| **Triage** | Decide whether an alert warrants investigation | Binary `INVESTIGATE` / `SKIP`, evaluating the incident's title, severity, and description |
| **Diagnosis** | Identify root cause using logs + runbooks | Mocked log tool + `pgvector` semantic retrieval over chunked runbooks (top-k, tenant-scoped); each chunk independently fenced and scanned before reaching the prompt |
| **Remediation** | Propose one concrete fix and a risk level | Structured JSON proposal (`action`, `riskLevel`), validated with Zod before it's ever shown to a human |

## Features

### 🏢 Multi-tenant SaaS foundation

Auth.js v5 (GitHub OAuth), organization-scoped data access enforced at the data-access-layer level rather than just the UI, three RBAC roles — Commander, Engineer, Observer — and encrypted-at-rest vaults for integration tokens.
Page-level access checks re-verify current organization membership and role through the DAL, so stale session claims do not determine current access.

### ⚙️ Durable agent orchestration

Upstash Workflow + QStash. Idempotent steps, automatic retry on transient failure, and a recovery path for the case where an incident is written to the database but the workflow trigger subsequently fails.

### 🛡️ Human-in-the-loop safety, enforced server-side

The approval gate isn't a disabled button — it's a `waitForEvent` pause in the workflow itself. The Server Action that resolves it re-checks Commander authorization, organization membership, incident ownership, and the `AWAITING_APPROVAL` state on every call.

Approval decisions are bound to the specific remediation proposal. The current execution path is simulated and cannot proceed through the workflow without an accepted human decision.

### 📡 Real-time Operations UI

Agent reasoning, tool calls, and proposed actions stream into the incident view via Server-Sent Events as they're written — no manual refresh. A shared `IncidentStreamProvider` powers synchronized timeline and reasoning panes through Next.js Parallel Routes, while Intercepting Routes let Commanders and Engineers inspect an incident in a dashboard modal without losing context.

Dashboards stay lightweight through conditional polling that only runs while an incident is actually active.

The reasoning feed uses an accessible log/live-region configuration to announce new activity politely. Retryable error boundaries cover Commander and Engineer incident reasoning/timeline panels and the Commander, Engineer, and Observer route sections.
### 🧠 Retrieval-augmented diagnosis

Runbooks are chunked, embedded, and stored in PostgreSQL with `pgvector`. Diagnosis retrieves relevant passages using cosine similarity and organization-scoped queries instead of loading every runbook into the prompt.

If indexing fails, the saved runbook can be repaired using the **Re-index** action available to Commander and Engineer users. Embeddings are generated before existing chunks are replaced, and deletion/insertion happen in a database transaction to avoid leaving a partial index after an insertion failure.
Retrieved content remains untrusted: chunks are fenced and scanned independently, and advisory tripwire events surface suspicious content or likely unretrieved-runbook citations for Commander review.

### 🚦 Rate limits and blast-radius control

Redis-backed sliding-window limits protect four independent boundaries:

| Boundary | Limit | Window |
| --- | ---: | --- |
| Public webhook, per client IP | 30 requests | 10 seconds |
| Webhook ingestion, per organization | 60 requests | 60 seconds |
| Commander approval, per user | 10 actions | 60 seconds |
| Remediation execution, per organization | 10 executions | 1 hour |

Webhook ingestion and execution **fail closed** if their required limiter can't operate.

Approval limiting follows a deliberately different policy: an explicit rate-limit denial is rejected, but a Redis infrastructure failure does not independently remove the human-approval path. Existing Commander authorization and incident-state checks remain mandatory either way.

When an approved action exceeds its organization's execution budget, Sentinel sets the incident to `ESCALATION_REQUIRED`, records `blast_radius_exceeded`, does not emit `action_executed`, and emits a terminal `workflow_finished` event with that reason.

See [`docs/Phase 6.md`](./docs/Phase%206.md) for the full design.

### 🔄 Workflow and incident lifecycle reliability

Workflow events can use stable, workflow-scoped deduplication keys backed by the unique `(orgId, externalId)` constraint. Approval decisions are bound to the specific proposal being reviewed, and execution uses the stored approved action.

An atomic `AWAITING_APPROVAL → EXECUTING` claim helps prevent competing workflow deliveries from claiming the same proposal. The simulated execution record and `RESOLVED` transition are written transactionally, as are conditional lifecycle state changes and their corresponding audit events.

These mechanisms improve retry and concurrency safety for supported paths; they do not guarantee exactly-once behavior for real infrastructure side effects.

The SSE replay/polling path uses a per-incident monotonic `streamSequence` cursor rather than `createdAt`, so late-visible events with older transaction timestamps are not skipped. A PostgreSQL trigger serializes sequence allocation until transaction completion, and the client retains event-ID deduplication as a defensive measure.
Prisma migrations are tracked in version control, and GitHub Actions validates the project using a clean dependency installation followed by Prisma validation/client generation, Next.js type generation, typechecking, linting, tests, and a production build.

### 🔐 Prompt safety

The system prompt separates trusted instructions from untrusted incident content, logs, runbooks, and retrieved chunks — every untrusted block is independently nonce-fenced.

Prompt-injection detection is an advisory tripwire: it records suspicious inputs for Commander review rather than treating a heuristic match as proof that content is safe or as a substitute for the approval gate.
The synthetic prompt-injection payload in `simulateAlert` is demo-only and is disabled by default. It is included only when `ENABLE_INJECTION_DEMO=true` is explicitly configured.

## Product Walkthrough

<div align="center">

<img src="./docs/assets/dashboard.png" alt="Commander dashboard with live incidents" width="800" />

<p align="center">
<i>Commander Bridge — incidents at varying severity and status, updating live via gated dashboard polling.</i>
</p>

<br /><br />

<img src="./docs/assets/modal.png" alt="Incident detail as an intercepting-route modal" width="800" />

<p align="center">
<i>Incident detail opened as a modal via Next.js Intercepting Routes — dashboard context stays visible underneath.</i>
</p>

<br /><br />

<img src="./docs/assets/reasoning.png" alt="Live agent reasoning feed on an awaiting-approval incident" width="800" />

<p align="center">
<i>Live agent reasoning streamed via Server-Sent Events (SSE). Triage, Diagnosis, and Remediation appear as the workflow progresses — no refresh required.</i>
</p>

</div>

## Tech Stack

**Implemented**

| Layer | Choice |
| --- | --- |
| Framework | Next.js 16 — App Router, Server Actions, Parallel & Intercepting Routes |
| Language & validation | TypeScript, Zod |
| Database | PostgreSQL (Neon serverless) |
| ORM | Prisma 7 with driver adapters |
| Auth | Auth.js v5, GitHub OAuth |
| Authorization | Database-backed organization membership and role checks |
| Styling | Tailwind CSS v4 |
| Orchestration | Upstash Workflow, QStash |
| AI | OpenAI SDK against Google's Gemini OpenAI-compatible endpoint |
| Embeddings & retrieval | `gemini-embedding-001`, `pgvector` (HNSW, cosine similarity) |
| Real-time | Server-Sent Events (polling-based, one connection per incident) |
| Rate limiting | Upstash Redis sliding-window limits for webhook IP/org, Commander approval, and execution blast-radius |
| Workflow reliability | Stable event deduplication keys, proposal-bound approvals, atomic execution claims, and transactional incident lifecycle events |
| Database change management | Version-controlled Prisma migrations |
| Testing & CI | Vitest and GitHub Actions (`npm ci`, Prisma validation/generation, typecheck, lint, tests, production build) |

**Phase 6 implementation status**

| Area | Status |
| --- | --- |
| Accessibility | Implemented: accessible live announcements on the reasoning feed |
| Error handling | Implemented: role-level and incident-panel error boundaries with retry actions |
| SSE replay | Implemented: per-incident monotonic `streamSequence` cursor handles late-visible events without timestamp-based skips; event-ID deduplication prevents duplicate delivery |
| Runbook indexing | Implemented: Commander/Engineer re-index action with transactional index replacement |
| Authorization recovery | Implemented: current DAL role/membership checks and generic error recovery |
| Demo prompt injection | Implemented: gated by `ENABLE_INJECTION_DEMO`, disabled by default |
| Environment configuration | Removed unused `UPSTASH_WORKFLOW_URL`; `DIRECT_URL` reviewed and retained for Prisma CLI/migrations |
| Public metadata | Deferred to Phase 11: `sitemap.ts`, `robots.ts`, and Open Graph images for postmortem pages |

## Roadmap

- [x] **Phase 0** — Foundations: Core SaaS, Edge RBAC, baseline architecture
- [x] **Phase 1** — Core CRUD
- [x] **Phase 2** — Ingestion & Event Store
- [x] **Phase 3** — Durable Agent Orchestration
- [x] **Phase 4** — Real-Time UI: SSE streaming, Parallel/Intercepting Routes, live approval reconciliation
- [x] **Phase 5** — AI Intelligence: `pgvector` RAG over runbooks
- [x] **Phase 6** — Hardening, Reliability & Polish ([details](./docs/Phase%206.md))
  - [x] Webhook IP and organization-level ingestion rate limiting
  - [x] Commander approval rate limiting with documented Redis-failure behavior
  - [x] Organization-level execution blast-radius control and explicit escalation
  - [x] Prisma migration history tracked and database migrations verified
  - [x] Workflow event deduplication for supported retry paths
  - [x] Proposal-bound approval decisions
  - [x] Atomic approved-execution claims and transactional simulated execution outcomes
  - [x] Server-side incident status validation and transactional lifecycle events
  - [x] GitHub Actions CI pipeline implemented and a successful `verify` run confirmed
  - [x] Accessible live announcements on the reasoning feed
  - [x] Error boundaries for Commander, Engineer, and Observer route sections
  - [x] Error boundaries for Commander and Engineer incident reasoning/timeline panels
  - [x] SSE replay uses the per-incident monotonic `streamSequence` cursor and event-ID deduplication
  - [x] Runbook re-index action protects existing chunks when embedding/index replacement fails
  - [x] Generic error recovery replaces brittle `error.message` string matching
  - [x] Removed unused `UPSTASH_WORKFLOW_URL` and audited `DIRECT_URL` configuration
  - [x] Gated simulated prompt-injection payload behind `ENABLE_INJECTION_DEMO` (default `false`)
  - [~] Public postmortem metadata deferred to Phase 11

Public postmortem metadata is intentionally deferred to Phase 11. Real-Postgres concurrency and rollback verification remains Phase 7 work.

## Getting Started

### Prerequisites

- Node.js and npm
- A PostgreSQL database (the documented setup uses Neon)
- GitHub OAuth App credentials
- Upstash QStash credentials
- Upstash Redis REST credentials (required — the rate limiters depend on them)
- A Google AI Studio API key
- `psql`, for the one-time `pgvector` setup below

### 1. Clone & install

```bash
git clone https://github.com/Gurashish73/sentinel.git
cd sentinel
npm ci
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in `.env`:

```bash
# App
NEXT_PUBLIC_APP_URL=          # use ngrok/cloudflared for local dev — see note below

# Database (Neon)
DATABASE_URL=
DIRECT_URL=

# Auth (GitHub OAuth App)
AUTH_SECRET=                  # npx auth secret
AUTH_GITHUB_ID=
AUTH_GITHUB_SECRET=

# Encryption (webhook secrets at rest)
ENCRYPTION_KEY=               # openssl rand -hex 32

# Durable workflow (Upstash)
QSTASH_URL=
QSTASH_TOKEN=
QSTASH_CURRENT_SIGNING_KEY=
QSTASH_NEXT_SIGNING_KEY=

# Rate limiting & blast-radius control (Upstash Redis) — required
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# AI (Google AI Studio)
GEMINI_API_KEY=
AGENT_MODEL=                  # optional, defaults to gemini-3.1-flash-lite
AGENT_EMBEDDING_MODEL=        # optional, defaults to gemini-embedding-001

# Demo-only simulated prompt-injection payload (disabled by default)
ENABLE_INJECTION_DEMO=false

```

> Verify your chosen model supports the OpenAI-compatible endpoint before changing `AGENT_MODEL` — newly created Gemini API keys are restricted from older model generations. See [Google's OpenAI compatibility docs](https://ai.google.dev/gemini-api/docs/openai).

### 3. Set up the database

Enable the `pgvector` extension on the database referenced by `DIRECT_URL` before applying the committed migration history:

```bash
psql "$DIRECT_URL" -c 'CREATE EXTENSION IF NOT EXISTS vector;'
```

Apply the version-controlled Prisma migrations and generate the client:

```bash
npx prisma migrate deploy
npx prisma generate
```

Use the tracked migrations as the source of truth for database changes in a migration-managed environment. Avoid using `prisma db push` as a substitute for applying the committed migration history. The migrations create the required schema constraints and indexes, including the HNSW vector index used by RAG.

### 4. Start the dev server

```bash
npm run dev
```

> **Local development note:** Upstash QStash needs a publicly reachable URL to deliver workflow steps and webhooks — tunnel `localhost` with ngrok or cloudflared and point `NEXT_PUBLIC_APP_URL` at the tunnel. `QSTASH_URL` is the QStash service endpoint, not your tunnel URL — keep it pointed at Upstash.

### Local verification

The GitHub Actions `verify` workflow runs a clean `npm ci` installation, Prisma schema validation and client generation, Next.js route type generation, TypeScript typechecking, linting, unit tests, and a production build.

Run the relevant checks locally before pushing changes:

```bash
npx prisma validate
npx prisma generate
npx next typegen
npm run typecheck
npm test
npm run lint
npm run build
```

The latest local Phase 6 follow-up validation passed **145 tests across 23 test files**, along with TypeScript typechecking, ESLint, Prisma schema validation, and `git diff --check`. The production build was re-run against the complete follow-up working tree and passed (`npm run build`). Automated PostgreSQL integration coverage for rollback, tenant isolation, broader transaction guarantees, and SSE load characterization remains planned for Phase 7. The SSE sequence trigger has also been exercised manually against Neon. Deployment-specific environment variables and trusted-proxy configuration still need verification in the target environment.

## Security & Deployment Notes

- **Human approval remains mandatory.** Agent output is a proposal, never authorization to execute.
- **Forwarded IP headers must be trusted correctly.** `getClientIp()` reads `x-forwarded-for` and `x-real-ip`; your reverse proxy must sanitize or overwrite those headers before they reach the app. Blindly trusting client-supplied forwarding headers would weaken IP-based rate limiting.
- **Redis failure policies are intentionally asymmetric.** Webhook ingestion and execution fail closed. Approval rate limiting preserves the human-approval path during a Redis outage, while keeping database-backed authorization and incident-state checks mandatory regardless.
- **Retrieved documents remain untrusted.** Prompt-injection tripwires improve visibility into suspicious content; they're heuristic, and a `false` result means "nothing obvious," not "provably safe."
- **Remediation is simulated.** Don't treat the current execution path as a production infrastructure executor.
- **Database verification boundary.** The unit suite covers many code paths with mocks. Real-PostgreSQL concurrency, transaction rollback, and SQL tenant-isolation verification are planned for Phase 7.

## Project Documentation

- [`docs/project-phases.md`](./docs/project-phases.md) — phase roadmap and completion tracker
- [`docs/Phase 0.md`](./docs/Phase%200.md) through [`docs/Phase 6.md`](./docs/Phase%206.md) — per-phase implementation notes
- [`docs/Phase 7.md`](./docs/Phase%207.md) — planned verification and test-rigor work
- [`docs/Phase 5 - RAG Trust Model.md`](./docs/Phase%205%20-%20RAG%20Trust%20Model.md) — trust model for retrieved context

---

<p align="center"><strong>Sentinel OS</strong> · Durable incident response with human authorization at the boundary.</p>
