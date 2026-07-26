# 🛡️ Sentinel OS

**An Autonomous Incident Response Agent Platform, gated behind human approval.**

[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?style=flat&logo=next.js)](https://nextjs.org/)
[![Prisma 7](https://img.shields.io/badge/Prisma-7-1B222D?style=flat&logo=prisma)](https://prisma.io/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Neon-336791?style=flat&logo=postgresql)](https://neon.tech/)
[![Tailwind v4](https://img.shields.io/badge/Tailwind-v4-06B6D4?style=flat&logo=tailwindcss)](https://tailwindcss.com/)

When production breaks, human engineers shouldn't be the first ones staring at logs at 3 AM. Sentinel is an autonomous event engine that catches webhooks (from GitHub, Sentry, Datadog), triggers a pipeline of AI agents to investigate, and proposes a fix.

Nothing executes automatically. Every proposed action sits behind a strict human approval gate.

## 🚀 The Architecture: Beyond a "RAG Wrapper"

Unlike basic LLM tools that call an API once to summarize logs, Sentinel utilizes a true **agentic reasoning loop**: `reason → call tool → observe result → reason again`.

It operates on a strict **7-Layer Tier-1 Architecture**:

### ✅ Implemented (Phases 0–3)

1. **Core SaaS:** Next.js App Router, Auth.js Edge RBAC (Commander, Engineer, Observer roles), multi-tenant org isolation, and encrypted vaults for integration tokens.
2. **Event Engine:** An immutable event store (`alert_received`, `action_proposed`, `action_approved`, ...) acts as the single source of truth. An action literally cannot execute until an `action_approved` event exists. Incidents and timeline events are managed via ACID transactions to prevent database lock contention.
3. **Durable Agent Orchestration:** Powered by Upstash Workflow/QStash. Agents run as idempotent, retryable steps. A crashed worker or duplicate webhook never double-executes. Every remediation action requires explicit human authorization before it runs — that gate is real and enforced server-side today.
4. **Human in the Loop Safety:**  Explicit authorization gates for all remediation actions. The agent literally cannot execute changes autonomously. Workflows pause indefinitely in the cloud awaiting explicit Commander approval via secured Server Actions.

### 🔜 Planned (Phases 4–7)

1. **Live Reasoning Stream:** Agent thoughts and tool calls streamed via SSE to a live UI in real-time. Today, the same reasoning is visible in the incident timeline on refresh, just not pushed live yet.
2. **AI Intelligence (RAG):** Per-tenant `pgvector` store of runbooks and past postmortems, with the Diagnosis Agent retrieving and citing relevant passages. Today, runbook content is passed directly as prompt context — accurate at small scale, not yet vector-searched.
3. **Edge DevOps & Hardening:** Vercel Edge runtime ingestion, Redis sliding-window rate limits, strict blast-radius controls, and CI/CD deployment blocks.

## 🧠 The Agent Pipeline (Vision & Current State)

* **Triage Agent:** Designed to dynamically classify severity and impact based on the incoming webhook payload.
  * *Currently (Phase 3):* Analyzes the incident description and makes a binary `INVESTIGATE` or `SKIP` decision based on the ingestion schema's pre-parsed severity.
* **Diagnosis Agent:** Built to perform RAG over the org's runbooks, call external observability tools to pull live metrics, and identify the root cause.
  * *Currently (Phase 3):* Evaluates against runbooks passed directly as prompt context and queries mock tool endpoints to simulate log retrieval. (Vector RAG scheduled for Phase 5).
* **Remediation Agent:** Proposes a definitive infrastructure fix (e.g., config rollback, service restart, draft code patch) and awaits human approval.
  * *Currently (Phase 3):* Generates a simulated action string and risk level (`low`, `medium`, `high`). The human-in-the-loop pause architecture is fully implemented and halts the workflow until a Commander approves.

## 🛠️ Tech Stack

**Currently Implemented:**

* **Framework:** Next.js 16 (App Router, Server Actions)
* **Database:** PostgreSQL (Neon serverless)
* **ORM:** Prisma 7 (with Edge Driver Adapters)
* **Authentication:** Auth.js v5 (GitHub OAuth App Integration)
* **Styling:** Tailwind CSS v4
* **AI Orchestration & Queue:** Upstash Workflow, QStash (for durable pauses), and OpenAI SDK (via GitHub Models)

**Incoming (Phases 4-6):**

* **State & Streaming:** React Suspense, `useOptimistic`, SSE (Server-Sent Events)
* **AI Intelligence:** `pgvector` for RAG
* **Rate Limiting:** Upstash Redis

## 🗺️ Development Roadmap & Status

Sentinel is being developed in strict, demoable milestones to ensure stability and continuous deployment.

* [x] **Phase 0:** Foundations (Core SaaS, Edge RBAC, Baseline Architecture)
* [x] **Phase 1:** Core CRUD
* [x] **Phase 2:** Ingestion & Event Store
* [x] **Phase 3:** Durable Agent Orchestration (The Core)
* [ ] **Phase 4:** Real-Time UI
* [ ] **Phase 5:** AI Intelligence (RAG)
* [ ] **Phase 6:** Hardening & Polish

## 💻 Getting Started

```bash
# 1. Clone the repository
git clone https://github.com/Gurashish73/sentinel.git

# 2. Navigate to the project directory
cd sentinel

# 3. Install dependencies
npm install

# 4. Configure Environment Variables
# Copy the example env file and fill in your keys
cp .env.example .env

# Core keys required to boot the app:
# - NEXT_PUBLIC_APP_URL & UPSTASH_WORKFLOW_URL (Use an ngrok tunnel for local dev)
# - DATABASE_URL & DIRECT_URL (Neon PostgreSQL)
# - AUTH_SECRET, AUTH_GITHUB_ID, AUTH_GITHUB_SECRET
# - ENCRYPTION_KEY (32-char string for webhook secrets)
# - QSTASH_TOKEN, QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY
# - GITHUB_TOKEN (For GitHub Models API)

# 5. Run database migrations
npx prisma db push

# 6. Start the development server
npm run dev
```

> **Note:** To test the Upstash QStash durable workflows locally, you must tunnel your localhost using a tool like ngrok or cloudflared.
