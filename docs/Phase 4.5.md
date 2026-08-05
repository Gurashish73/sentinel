# Phase 4.5 — Agent Safety Hardening

## Overview

Phase 4 completed Sentinel's live, human-reviewed agent pipeline by wiring
Triage, Diagnosis, and Remediation into a durable workflow with real-time
reasoning streamed directly to the Commander.

Before introducing retrieval in Phase 5, one architectural gap remained:
incident data — although HMAC-authenticated — ultimately originates from an
external webhook and is therefore **content-untrusted**. That data was being
interpolated directly into LLM prompts without any structural separation from
system instructions.

Phase 4.5 closes that gap by introducing structural prompt isolation,
lightweight prompt-injection detection, stricter runtime payload safety, and
comprehensive security-focused test coverage across every agent stage.

---

## Security & Prompt Architecture

## 1. Structural Isolation over Sanitization

Prompt injection is not solved by trying to remove dangerous words.

Attempting to sanitize arbitrary user input inevitably becomes an endless
pattern-matching race where new phrasing simply bypasses the filters.
More importantly, silently rewriting incoming incident data hides potential
tampering from the one person ultimately responsible for the final decision.

Instead, Sentinel now enforces **structural isolation**.

Every instruction the model must follow lives exclusively inside the
`system` message, while every externally-derived input (incident title,
description, logs, runbooks, diagnosis summaries) is wrapped inside explicit
`<untrusted_*>` blocks within the `user` message.

Rather than attempting to "clean" attacker-controlled content, the model is
given clear architectural boundaries describing what should and should not be
treated as executable instructions.

---

## 2. Detection as a Tripwire, Not a Gate

Phase 4.5 deliberately avoids blocking prompts based on heuristic matching.

Instead, `containsSuspectedInjection()` scans external inputs for common
prompt-injection phrasing such as:

- ignore previous instructions
- disregard system prompt
- set riskLevel to low
- execute immediately

When detected, the workflow emits a new `injection_suspected` event.

Importantly, this **never changes agent behavior.**

The event exists solely to inform the Commander that suspicious content was
observed while the proposal was generated.

The human approval gate introduced in Phase 3 remains the actual security
boundary.

Detection improves human awareness.

Approval remains the enforcement mechanism.

---

## 3. Taint Propagation

Not all untrusted content enters directly from the webhook.

Outputs produced by earlier agents are themselves derived from untrusted
inputs.

For example:

Webhook
→ Diagnosis Summary
→ Remediation Prompt

Although the Remediation agent only consumes the diagnosis summary, that
summary is ultimately influenced by the original incident payload.

Phase 4.5 therefore treats every downstream artifact as tainted unless it
originates from trusted application code.

Diagnosis summaries now undergo the same structural fencing and heuristic
scanning before reaching the Remediation agent.

An injection that survives one stage does not receive implicit trust in the
next.

---

## 4. Runtime JSON Safety

`emitAgentEvent()` previously relied on:

```ts
payload: event as any
```

While accepted by TypeScript, this merely suppressed compile-time checking.

Instead, payloads now pass through a JSON serialization round-trip before
being written into Prisma's `Json` column.

This guarantees at runtime that persisted payloads are actually JSON-safe
rather than assuming they are.

The objective is not satisfying the type checker.

The objective is ensuring the database only ever receives valid JSON values.

---

## 5. Coverage Parity

Prior to this phase, Remediation already had extensive adversarial testing.

Triage and Diagnosis did not.

Phase 4.5 brings all three agents to the same security standard.

New test suites verify:

- malformed model responses
- empty completions
- prompt separation
- structural fencing
- injection detection
- taint propagation
- unchanged control flow after suspicious inputs

Every stage of the pipeline now follows identical security and failure
guarantees.

---

## Developer Notes & Architecture Decisions

- **Structural isolation over sanitization.**
  Security comes from separating trusted instructions from untrusted content,
  not from attempting to sanitize attacker-controlled text.

- **Detection is intentionally advisory.**
  The heuristic scanner improves Commander visibility but deliberately makes
  no authorization decisions.

- **Security boundaries remain unchanged.**
  Phase 4.5 introduces no new authorization logic. Human approval remains the
  only component capable of authorizing infrastructure changes.

- **Trust does not increase downstream.**
  Any artifact derived from external input is treated as tainted until proven
  otherwise.

- **Runtime validation over compile-time assertions.**
  JSON serialization provides a real runtime guarantee where `as any` merely
  suppresses compiler warnings.

- **Equivalent security guarantees across every agent.**
  Security features are only valuable if every stage behaves consistently,
  which is why all three agents now share comparable adversarial coverage.

---

## Implementation Checklist

- [x] Create `src/agents/prompt-safety.ts`
  - `wrapUntrusted()`
  - `containsSuspectedInjection()`
  - `AGENT_SYSTEM_PREAMBLE`

- [x] Add `injection_suspected` to the typed `AgentEvent` protocol.

- [x] Replace `payload: event as any` with JSON serialization before writing
      Prisma `Json` payloads.

- [x] Refactor `src/agents/triage.ts`, `src/agents/diagnosis.ts`, and
  `src/agents/remediation.ts` to separate `system` and `user` prompts.

- [x] Fence every external-origin input using `<untrusted_*>` wrappers.

- [x] Scan incident data, logs, runbooks, and diagnosis summaries for
      suspected prompt injection.

- [x] Surface `injection_suspected` events inside the live
      `IncidentReasoningFeed`.

- [x] Add comprehensive tests covering:
  - prompt isolation
  - malformed model responses
  - heuristic detection
  - taint propagation
  - empty completions
  - unchanged control flow

---

## Definition of Done

- [x] No agent prompt interpolates untrusted content into the `system`
      message.

- [x] Every externally-derived input is structurally fenced before reaching
      the model.

- [x] Prompt injection attempts generate visible
      `injection_suspected` events without altering workflow behavior.

- [x] Agent outputs remain Zod-validated and human-approved regardless of
      detected injection attempts.

- [x] Runtime JSON safety replaces unsafe compile-time type assertions.

- [x] Triage, Diagnosis, and Remediation maintain equivalent security and
      edge-case test coverage.

---

## What This Does *Not* Solve

Phase 4.5 deliberately hardens prompt integrity within the existing agent
pipeline. It does **not** attempt to solve every AI security problem.

- **Heuristic Limits:** Regex-based detection remains heuristic and can be
  bypassed through sufficiently indirect phrasing. A negative result should
  be interpreted as "nothing obvious was detected," not "the prompt is safe."

- **Webhook Rate Limiting:** Public webhook protection remains intentionally
  deferred to **Phase 6**.

- **Retrieval Security:** Phase 5 introduces `pgvector` retrieval. Retrieved
  documents will require the same structural fencing applied here before
  entering future RAG prompts.

- **Human Approval:** The Commander remains the final authorization boundary.
  Phase 4.5 improves the information available for that decision—it does not
  replace it.
