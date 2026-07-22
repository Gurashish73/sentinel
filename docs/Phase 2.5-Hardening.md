# Phase 2.5 — Security & Infrastructure Hardening

**Context:** Following the completion of the Phase 2 Webhook Ingestion pipeline, a comprehensive architectural review identified several areas for infrastructure hardening. Before introducing the complex state machines and LLM orchestrations of Phase 3, this intermediary phase ensures the foundation is mathematically sound, performant, and covered by automated tests.

---

## 1. Cryptographic Performance Optimization

The `scryptSync` function in `src/lib/crypto.ts` was deliberately expensive by design, but it was being executed on every single encrypt/decrypt call. Because it derives a deterministic key from a static environment variable, this was burning CPU cycles on every webhook request for no added security.

* **Fix:** Hoisted the `KEY` derivation to module-load time. It now runs exactly once when the Node process boots.

## 2. Environment Variable Strictness

`ENCRYPTION_KEY` was left as an optional environment variable during Phase 1 scaffolding. Now that it is a load-bearing requirement for webhook signature verification, it must be strictly enforced.

* **Fix:** Updated `env.ts` Zod schema to require `ENCRYPTION_KEY` (minimum 32 characters). The app now fails-fast at boot if it is missing, preventing silent cryptographic failures in production.

## 3. Database Query Determinism

The Auth.js JWT callback (`src/auth.ts`) queried the user's default organization using a `findFirst` without an `orderBy` clause. This relied on the implicit ordering of Postgres, which is non-deterministic and could lead to unpredictable session routing if a user has multiple memberships.

* **Fix:** Added `orderBy: { id: "asc" }` to guarantee deterministic resolution of the default organization based on the oldest membership.

## 4. Test-Driven Security Boundaries

The `verifyHmacSignature` and `decryptSecret` functions are pure, dependency-free functions where a silent bug is both catastrophic and cheap to catch.

* **Fix:** Implemented a minimal, high-value testing suite using **Vitest**.
* **Fix:** Added test-only shims (`tests/empty-module.ts`) to allow Next.js `server-only` packages to run within the Vitest environment without booting the full React bundler.
* **Fix:** Caught and patched a regression in `webhook-verify.ts` where explicit provider prefix normalization (`sha256=`, `v1=`) was bypassing length checks. Re-secured with `try/catch` boundaries and strict `!secret` gating to prevent DoS via unhandled Node.js exceptions.

---

## Definition of Done

* [ ] `crypto.ts` optimized for module-load key derivation.
* [ ] `env.ts` strictly enforces `ENCRYPTION_KEY`.
* [ ] `auth.ts` uses deterministic `orderBy`.
* [ ] Vitest configured and running via `npm run test`.
* [ ] Security test suites (`crypto.test.ts` and `webhook-verify.test.ts`) pass with 100% success.
* [ ] `webhook-verify.ts` properly implements prefix stripping, length verification, and `try/catch` fail-safes.
