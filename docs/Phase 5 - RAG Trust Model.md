# Phase 5 Pre-Work: RAG Trust Model

> **Status:** Design approved. Implementation deferred until Phase 5.

## Why this exists

This document records the trust model for retrieval before any `pgvector` or RAG implementation is written.

The goal is to answer one question first:

> When `retrieveRelevantDocuments(...)` returns chunks, how should those chunks enter the LLM prompt?

Answering this before implementation avoids refactoring every prompt-builder call site later. Phase 5 should extend the existing prompt safety model rather than introduce a second trust model.

---

## Core Decision

**Retrieved context is untrusted by default.**

No exceptions are made simply because:

- we embedded it ourselves,
- it came from our own database,
- or it was returned by similarity search.

Storage is not authentication.

Phase 4.5 already treats organization-owned runbooks as untrusted content. Retrieval does not upgrade that trust level.

A malicious or careless edit to a runbook, postmortem, or future knowledge source should be treated exactly like an untrusted webhook payload.

---

## Threat Model

Consider the following scenario:

1. Someone writes a runbook containing embedded instructions.
2. The document is embedded and stored in the vector database.
3. Weeks later, an unrelated production incident retrieves that document because it is semantically relevant.
4. The retrieved chunk is inserted into an LLM prompt.

Unlike webhook payloads, retrieved chunks bypass the webhook trust boundary entirely.

Therefore every retrieved chunk must pass through the same prompt safety layer already used for:

- incident title
- incident description
- logs
- runbooks

---

## Prompt Construction

Phase 4.5 already provides the required primitive:

```ts
wrapUntrusted(...)
```

Current prompt construction already wraps:

```ts
wrapUntrusted("incident", ...)
wrapUntrusted("logs", ...)
wrapUntrusted("runbooks", ...)
```

Phase 5 should simply extend the same pattern.

Example:

```ts
wrapUntrusted("retrieved_runbook_0", chunk.content)

wrapUntrusted("retrieved_postmortem_3", chunk.content)
```

No new trust model should be introduced.

---

## Prompt Injection Detection

Each retrieved chunk should be scanned individually using:

```ts
containsSuspectedInjection(...)
```

Scanning individual chunks allows Sentinel to attribute a tripwire event to a specific document rather than to retrieval as a whole.

---

## Event Protocol

No new event type is required.

The existing:

```text
injection_suspected
```

event already supports a free-form `source` field.

Phase 5 should extend that field with values such as:

```text
retrieved_runbook:<id>

retrieved_postmortem:<id>

retrieved_chunk:<id>
```

This allows Commander to identify exactly which retrieved document triggered the tripwire.

---

## What Does Not Change

The following Phase 4.5 guarantees remain unchanged:

- The system prompt never receives interpolated external content.
- Human approval remains the only authority capable of executing remediation.
- Prompt injection detection remains a non-blocking tripwire.
- Retrieved content is never silently rewritten or discarded.

---

## Phase 5 Implementation Checklist

- [ ] Add `wrapRetrievedChunks()` helper to `prompt-safety.ts`.
- [ ] Add `scanRetrievedChunks()` helper.
- [ ] Scan retrieved chunks before prompt construction.
- [ ] Emit `injection_suspected` with the specific retrieved document as the source.
- [ ] Add tests proving prompt injection is detected inside retrieved chunks.
- [ ] Add smoke tests for the webhook, workflow, and stream route handlers while Phase 5 touches those paths.

---

## Design Principle

Retrieval introduces a new source of context.

It does **not** introduce a new trust boundary.

Every piece of retrieved context must follow the same Prompt Safety architecture established in Phase 4.5.
