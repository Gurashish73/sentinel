# Phase 1: Core CRUD & Secure Data Access

## Overview

Phase 1 transitions Sentinel from a foundational shell into a fully functional operational dashboard. The primary goal is to ensure incidents and runbooks are manageable through the UI via server-rendered pages and Zod-validated Server Actions, with strict role and organizational boundaries enforced at the database level.

## Developer Notes & Architecture Decisions

* **Defense-in-Depth (DAL):** Implemented a centralized Data Access Layer (`src/lib/dal.ts`) to prevent Next.js middleware bypasses and JWT staleness. All state mutations now require a fresh DB-backed check rather than trusting the cached browser session.
* **Strict Multi-Tenant Isolation:** All database queries are strictly scoped by `orgId`. Added a critical `/onboarding` redirect for zero-membership users to prevent Prisma's `undefined` parameter from dropping the `where` clause and leaking cross-tenant data.
* **Server vs. Client Component Split:** Maximized performance and security by keeping list/detail views as shared Server Components. Client Components are strictly isolated to interactive forms requiring `useFormStatus` and `useActionState`.
* **Pre-emptive Secret Encryption:** Introduced `src/lib/crypto.ts` (AES-256-GCM) to encrypt sensitive inputs like webhook secrets and GitHub tokens before they hit the database, preventing future rework for Phase 2.
* **Targeted Cache Invalidation:** Leveraged Next.js `revalidateTag` within Server Actions to ensure UI components reflect mutations (like incident status changes) instantly without full page reloads.

## Implementation Checklist

### 0. Fix-First Carry-Over

* [x] Confirm `/login` is not nested inside the `(app)` route group.
* [x] Point the no-session fallback redirect in `(app)/layout.tsx` to `/login`.
* [x] Add a DB-backed check in `(app)/layout.tsx` to catch zero-membership users and force them to `/onboarding`.
* [x] Add `eslint`, `eslint-config-next`, and `@types/node` to `devDependencies`.
* [x] Unify event type casing (e.g., SCREAMING_SNAKE_CASE) in `lib/event.ts` and `schema.prisma`.
* [x] Read the seed user's email from `process.env.SEED_USER_EMAIL` in `seed.ts`.

### 1. Data Access Layer (`src/lib/dal.ts`)

* [x] Implement `requireSession()` to guarantee active authentication.
* [x] Implement `requireMembership(orgId)` for fresh DB reads to gate mutations.
* [x] Implement `requireRole(orgId, allowedRoles)` to enforce strict RBAC.

### 2. Server Actions & Queries

* [x] **Incidents:** Create `createIncident` and `updateIncidentStatus` actions (Zod-validated, role-gated to COMMANDER/ENGINEER, tagged for revalidation).
* [x] **Runbooks:** Create create/update/delete actions (role-gated, tagged for revalidation).
* [x] **Organization:** Create `updateOrgSettings` (COMMANDER only) and wire up `crypto.ts` for secrets.
* [x] **Queries:** Ensure `getIncidentsForOrg` and `getRunbooksForOrg` are strictly scoped by `orgId` and properly tagged.

### 3. Pages & UI Construction

* [x] Build shared Server Components: `incident-list.tsx` and `incident-detail.tsx`.
* [x] Build Client Component: `create-incident-form.tsx`.
* [x] Wire up thin role-specific `page.tsx` files for Commander, Engineer, and Observer route groups.
* [x] Create `src/app/(app)/error.tsx` to intercept thrown `requireRole` errors with a prompt to re-authenticate.
* [x] Extend `seed.ts` to generate fake `Incident` rows for dashboard visualization.

### 4. Definition of Done

* [x] Commander can manage orgs, incidents, and runbooks.
* [x] Engineer can create incidents and view real-time updates.
* [x] Observer has strict read-only access (mutations rejected server-side).
* [x] Zero-membership users land safely on `/onboarding`.
* [x] `npm run lint` executes cleanly.
