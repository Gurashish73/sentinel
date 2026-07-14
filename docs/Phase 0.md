# Phase 0: Foundations

## Overview

Phase 0 establishes the Tier-1 architectural baseline for Sentinel. The goal is to set up a secure, Edge-ready full-stack environment with functional role-based access control (RBAC) before touching the core product features.

## Developer Notes & Architecture Decisions

* **Manual Setup Over Generators:** Bootstrapped manually without `create-next-app` to ensure strict control over dependencies, avoiding legacy CommonJS configurations and enforcing ESM (`"type": "module"`).
* **Next.js 16 Edge Proxy Routing:** Utilized the modern `proxy.ts` convention to intercept traffic at the Edge. This safely routes unauthenticated users to `/login` and dynamically directs authenticated sessions to their highest-privileged dashboard (`COMMANDER`, `ENGINEER`, or `OBSERVER`).
* **Prisma 7 Edge-Ready Data Layer:** Decoupled standard Node.js native database bindings by utilizing the explicit Prisma Driver Adapter pattern with a standard PostgreSQL connection pool.
* **Serverless PostgreSQL:** Wired to a Neon cloud database to ensure the architecture supports horizontal scaling and edge execution right out of the box.
* **Auth.js v5 (NextAuth):** Configured with a GitHub OAuth App to act as the primary identity provider, stripping the need for local password management and instantly provisioning user records via the Prisma adapter.
* **Tailwind CSS v4:** Integrated using the new `@tailwindcss/postcss` compilation engine for dynamic utility class generation.
* **Database Seeding:** Created a custom TypeScript seeder (`seed.ts`) to manually bootstrap the `sentinel-hq` organization and grant the initial `COMMANDER` role, validating the session-refresh mechanics.

## Implementation Checklist

* [ ] **01 App Router Structure:** Fully operational with `src/app` architecture.
* [ ] **03 Secure Init & Env Control:** Handled via runtime safety and `.env` isolation (webhook HMAC and token vaults deferred to Phase 2).
* [ ] **04 Root Layout & Nested Routes:** Authenticated shell layout established wrapping `(app)/commander`, `(app)/engineer`, and `(app)/observer` route groups.
* [ ] **15 Authentication (Auth.js):** Session generation, database syncing, and Edge RBAC routing successfully implemented and verified.
