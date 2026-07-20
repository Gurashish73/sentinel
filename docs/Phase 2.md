# Phase 2: Ingestion & Event Store

## Overview

Phase 2 establishes a durable and idempotent ingestion pipeline for Sentinel. The primary goal is to ensure that external alerts (or manually simulated ones) land safely in an immutable `Event` table and automatically trigger `Incident` creation. This must be handled securely by verifying encrypted webhook secrets and gracefully handling provider retries without ever double-processing a delivery.

## Developer Notes & Architecture Decisions

* **Idempotency via Database Constraints:** Leveraged Postgres' handling of nullable unique constraints (`@@unique([orgId, externalId])`) on the `Event` table. This acts as a deduplication key at the database level, preventing race conditions or double-processing of retried webhooks.
* **Raw Body HMAC Verification:** Enforced signature verification against the *raw* request body string rather than parsed JSON. This prevents signature verification failures caused by JSON serialization differences (e.g., whitespace padding or key order changes).
* **Unified Ingestion Logic:** Abstracted the incident creation and event logging into a shared `ingestAlert` utility. This ensures both HTTP webhook routes and UI-driven Server Actions share the exact same idempotency and validation rules.
* **Graceful Idempotent Responses:** A duplicate delivery (caught via Prisma's `P2002` unique constraint error) is caught and returns a `200 OK` with a `duplicate` status rather than throwing a `409 Conflict` or `500 Error`. This ensures the external provider (e.g., GitHub, Sentry) considers the delivery successful and stops retrying.
* **Security through Obscurity (404s):** Designed the webhook API route to return an identical `404 Not Found` for both non-existent organizations and organizations missing a webhook secret. This prevents malicious actors from enumerating valid organization slugs.

## Implementation Checklist

### 0. Schema Updates

* [ ] Add an `externalId` string field to the `Event` model to store provider delivery IDs (e.g., GitHub's `X-GitHub-Delivery`).
* [ ] Add a `@@unique([orgId, externalId])` constraint to the `Event` model to enforce idempotency.
* [ ] Generate and apply the migration: `npx prisma migrate dev --name add_event_external_id`.

### 1. Core Ingestion Logic (`src/lib/ingest-alert.ts`)

* [ ] Define a strict Zod `alertSchema` to validate incoming payload shapes.
* [ ] Implement `ingestAlert(orgId, input)` to handle creating the `Incident` and its corresponding `Event` log.
* [ ] Add a `try/catch` block to intercept Prisma `P2002` errors and safely return `{ status: "duplicate" }`.

### 2. Security & Verification (`src/lib/webhook-verify.ts`)

* [ ] Implement `verifyHmacSignature` using `node:crypto` (`createHmac` and `timingSafeEqual`).
* [ ] Add a strict buffer length check before executing the constant-time comparison to prevent runtime exceptions.

### 3. Webhook API Route (`src/app/api/webhooks/alert/[orgSlug]/route.ts`)

* [ ] Look up the organization by slug and handle missing orgs/secrets with a generic `404`.
* [ ] Decrypt the organization's webhook secret in-memory.
* [ ] Verify the `x-signature` header against the raw request body, returning `401` on failure.
* [ ] Parse and validate the payload, returning `400` for malformed JSON and `422` for schema violations.
* [ ] Pass valid payloads to `ingestAlert` and return a `200` status for both new creations and duplicate catches.

### 4. UI & Testing Integration

* [ ] Create a Server Action `simulateAlert` in `src/actions/webhooks.ts` that is strictly role-gated to `COMMANDER`.
* [ ] Wire a "Simulate alert" button on the Commander dashboard using `useTransition` to trigger the action and automatically update the UI cache via `updateTag`.
* [ ] Validate webhook verification locally using `openssl` to generate a signature and `curl` to simulate a payload.

### 5. Definition of Done

* [ ] A correctly-signed request creates exactly one `Incident` and one `Event`.
* [ ] The same request replayed returns a `duplicate` status, not a second incident.
* [ ] A request with a tampered body or incorrect secret is rejected with a `401`, not a `500`.
* [ ] The "Simulate alert" button works end-to-end and updates the incident list without requiring a manual browser refresh.
* [ ] `org.webhookSecret` is strictly handled in-memory on the server and never leaked in any API response.
