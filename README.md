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

1. **Core SaaS:** Next.js App Router, Auth.js Edge RBAC (Commander, Engineer, Observer roles), multi-tenant org isolation, and encrypted vaults for integration tokens.
2. **Event Engine:** An immutable event store (`ALERT_RECEIVED`, `AGENT_ACTION_PROPOSED`, `ACTION_APPROVED`) acts as the single source of truth. An action literally cannot execute until an `ACTION_APPROVED` event exists.
3. **Durable Agent Orchestration:** Powered by Upstash QStash. Agents run as idempotent, retryable steps. A crashed worker or duplicate webhook never double-executes.
4. **Live Reasoning Stream:** Agent thoughts and tool calls are streamed via SSE to a live UI War Room in real-time.
5. **AI Intelligence:** Per-tenant `pgvector` store of runbooks and past postmortems. The Diagnosis Agent grounds its reasoning in retrieved internal docs and explicitly cites them.
6. **Human-in-the-Loop Safety:** Redis sliding-window rate limits, strict blast-radius controls, and explicit authorization gates for all remediation actions.
7. **Edge DevOps:** Vercel Edge runtime ingestion, CI/CD GitHub action deployment blocks, and strict schema validation.

## 🧠 The Agent Pipeline

* **Triage Agent:** Classifies severity and impact based on incoming webhook payload.
* **Diagnosis Agent:** Performs RAG over the org's runbooks, calls tools to pull live metrics/logs, and identifies the root cause.
* **Remediation Agent:** Proposes a definitive fix (e.g., config rollback, service restart, draft code patch) and awaits human approval.

## 🛠️ Tech Stack

* **Framework:** Next.js 16 (App Router, Server Actions, Edge Proxy)
* **Database:** PostgreSQL (Neon serverless)
* **ORM:** Prisma 7 (with Edge Driver Adapters)
* **Authentication:** Auth.js v5 (GitHub OAuth App Integration)
* **Styling:** Tailwind CSS v4
* **State & Streaming:** React Suspense, `useOptimistic`, SSE (Server-Sent Events)
* **Queue & Cache:** Upstash Redis & QStash

## 🗺️ Development Roadmap & Status

Sentinel is being developed in strict, demoable milestones to ensure stability and continuous deployment.

* [ ] **Phase 0:** Foundations (Core SaaS, Edge RBAC, Baseline Architecture)
* [ ] **Phase 1:** Core CRUD
* [ ] **Phase 2:** Ingestion & Event Store
* [ ] **Phase 3:** Durable Agent Orchestration (The Core)
* [ ] **Phase 4:** Real-Time UI
* [ ] **Phase 5:** AI Intelligence (RAG)
* [ ] **Phase 6:** Hardening & Polish

## 💻 Getting Started

> **Note:** Sentinel is currently in active development. Detailed local setup instructions, including database proxy configuration and environment variables, will be provided shortly.

```bash
# Clone the repository
git clone [https://github.com/YOUR_USERNAME/sentinel.git](https://github.com/YOUR_USERNAME/sentinel.git)

# Navigate to the project directory
cd sentinel

# Install dependencies
npm install
