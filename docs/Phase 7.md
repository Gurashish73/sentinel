# Phase 7: Verification & Test Rigor

## Status

**Planned — not yet implemented.** This document defines the work required for Phase 7. The checklists below are intentionally unchecked; items should be marked complete only after implementation and verification.

## Overview

Phases 2–6 introduced important reliability claims: atomic execution claims, first-writer-wins approval decisions, compare-and-set lifecycle transitions committed with their audit events, and deduplicated workflow events backed by database constraints.

The current automated suite relies heavily on mocked Prisma clients. Mocks can verify that application code calls methods in a particular order, but they cannot prove that PostgreSQL arbitrates concurrent writes as expected, that database transactions roll back after a failed audit write, or that the committed migration history creates the schema the application requires.

**Phase 7 will close that verification gap.** It will add real-PostgreSQL integration tests, concurrency tests for important race conditions, rollback tests that inject failures inside transactions, tenant-isolation tests against the SQL boundary, an agent evaluation harness, and an initial load characterization of the SSE endpoint.

This phase focuses on evidence for existing behavior rather than adding product features.

## Goals

- Verify database-level concurrency and transaction guarantees against real PostgreSQL.
- Prove the committed Prisma migration history can build a working schema from an empty database.
- Test organization isolation at the SQL and retrieval boundaries.
- Measure agent behavior on a versioned set of representative incidents and prompt-injection examples.
- Record the practical connection/query ceiling of the current SSE polling implementation.
- Keep fast unit tests separate from slower integration and model-evaluation suites.

## Out of Scope

- Implementing real infrastructure execution; that is Phase 8.
- Replacing mocked log retrieval with a real provider; that is Phase 9.
- Replacing the SSE polling architecture; Phase 7 measures its limitations, while scaling work belongs to Phase 10.
- Treating agent evaluations as proof of general correctness. The harness will measure regressions on a finite dataset only.

---

## Developer Notes & Architecture Decisions

### 1. Keep Unit and Integration Tests Separate

Existing mocked unit tests will remain fast and continue to run on every pull request. Integration tests will run in a separate Vitest configuration against a real PostgreSQL database with `pgvector` enabled.

Planned structure:

```text
vitest.config.ts                 # existing unit-test configuration
vitest.integration.config.ts     # new integration-test configuration
tests/integration/
  setup.ts
  fixtures.ts
  *.integration.test.ts
```

A new `npm run test:integration` script will run the integration suite. The exact Vitest project configuration should be confirmed against the installed Vitest version during implementation.

### 2. Run PostgreSQL in CI

The integration CI job will use a `pgvector/pgvector` service container rather than a developer's database or a hosted environment.

The job will:

1. Start with an ephemeral, empty database.
2. Create the `vector` extension before applying migrations, matching the project's documented setup.
3. Apply the committed migration history with `prisma migrate deploy`.
4. Run integration tests against that database.
5. Fail the job if migration application or integration verification fails.

Upstash Redis, QStash, and Gemini will remain mocked for these tests. This tier is intended to prove database-level guarantees, not third-party service behavior. CI credentials must be test-only; no production service secrets should be required by the integration job.

### 3. Isolate Test Data

Each integration test will start from a clean database state. A shared setup helper will truncate relevant application tables, using foreign-key-safe ordering and `CASCADE` where appropriate.

Proposed baseline SQL, to be adapted to the actual schema and any additional tables:

```sql
TRUNCATE "Event", "RunbookChunk", "Runbook", "Incident",
         "Membership", "Organization", "User"
RESTART IDENTITY CASCADE;
```

Fixture builders such as `createOrg`, `createIncident`, and `createAwaitingApprovalIncident` will live in `tests/integration/fixtures.ts`. Fixtures should create the minimum records required for each case and avoid relying on shared state across tests.

The setup must use the same database connection configuration as the integration job, and cleanup must not run against a developer's normal database accidentally. The integration command should fail fast when its database URL is missing or clearly points at a non-test database.

### 4. Test Real Concurrent Races

Concurrency guarantees will be exercised with concurrent operations against PostgreSQL, not inferred from mocked call sequences.

Planned scenarios:

- **Double claim:** Run two `claimApprovedExecution` calls concurrently for the same proposal. Exactly one should win the `AWAITING_APPROVAL → EXECUTING` transition, with exactly one `action_execution_claimed` event.
- **Approve versus reject:** Run `respondToProposedAction(approved: true)` and `respondToProposedAction(approved: false)` concurrently for the same proposal. Exactly one decision should be persisted; the losing operation should return or throw the existing conflicting-decision result.
- **Double completion:** Run two `completeApprovedExecution` calls concurrently. Exactly one `action_executed` event and one `RESOLVED` transition should be persisted.
- **Timeout versus claim:** Race a workflow-timeout transition against an execution claim. Exactly one valid transition should win, and the losing operation should report the established `superseded` result.

Each scenario should run repeatedly (for example, 25 iterations) with freshly seeded records. Repetition increases the chance of exposing ordering bugs, but a passing test should not be described as a formal proof of every possible interleaving.

Before implementing a test, verify the actual function signatures, event names, transition rules, and intended loser semantics in the current source. The test should assert the documented contract rather than inventing new behavior.

### 5. Verify Rollback Through Fault Injection

A key invariant is that a transaction must not leave incident state updated when its associated audit/event write fails. This needs a real database transaction to verify.

The integration suite will inject an error into a selected event-write operation using an isolated Prisma client extension or another test-only mechanism compatible with the current Prisma version. The fault must occur within the transaction being tested; an error thrown before the transaction begins does not prove rollback.

Planned cases:

- `transitionIncidentWithEvent` when its event/audit write fails.
- `claimApprovedExecution` when its claim-event write fails.
- `completeApprovedExecution` when its execution-event write fails.
- `updateIncidentStatus` when its audit write fails.

For each case, the test will assert that the operation fails and that the relevant database state remains unchanged. It should also check that no partial event or decision record remains where the operation is expected to be atomic.

### 6. Verify Idempotency and Replay Behavior

Durable workflow steps may be replayed. The integration suite will run selected lifecycle operations twice and assert that the second invocation has the expected no-op/replay result without duplicating observable effects.

Planned cases:

- Replayed claim returns the established `claimed` result without creating a second claim event.
- Replayed completion returns the established `completed` result without creating a second execution event.
- Replaying `emitAgentEvent` with the same deduplication key returns `false` and leaves exactly one matching event.
- A `P2002` caused by a different unique constraint is not accidentally swallowed as a deduplication success.

These tests should query persisted rows after both calls. Mock call counts alone are not sufficient evidence for database idempotency.

### 7. Verify Tenant Isolation at the Database Boundary

Tenant isolation must be tested where the filtering actually occurs, especially in raw SQL vector retrieval.

Planned tests:

- Seed two organizations with equivalent runbook content and embeddings. Verify `retrieveRelevantChunks(orgA, ...)` never returns a chunk belonging to organization B.
- Verify incident, event, and runbook retrieval paths only return records scoped to the requested organization.
- Where practical, test the raw SQL or query helper directly so the test exercises the `WHERE` clauses rather than merely checking that a mocked method received an `orgId` argument.

The tests should include an adversarial fixture where matching content exists in another organization; otherwise, an accidental missing organization predicate could go undetected.

### 8. Build an Agent Evaluation Harness

Agent behavior is probabilistic, so Phase 7 will measure it across a repeatable dataset instead of relying only on canned LLM mocks.

Planned structure:

```text
evals/
  golden-incidents.json
  injection-corpus.json
  run-evals.ts
```

**Golden incident set:** Start with approximately 30 representative incidents, each with an expected triage label and explicit acceptance criteria for remediation proposals (for example, schema-valid output and an acceptable risk level). Record the source and rationale for each label so the dataset can be reviewed and versioned.

**Injection corpus:** Include prompt-injection examples in incident titles, descriptions, logs, and retrieved runbook chunks. Include direct and indirect phrasing, plus benign examples to help identify false positives.

Metrics will include:

| Metric | Meaning |
|---|---|
| Triage accuracy | Fraction of cases where the triage verdict matches the expected label. |
| Proposal validity rate | Fraction of remediation outputs that pass the current Zod schema. |
| Tripwire recall | Fraction of injection corpus items that trigger `injection_suspected`. |
| Injection influence rate | Fraction of paired runs in which injected text measurably changes the output in an unsafe or policy-relevant way. |

Tripwire recall below 100% is expected because the detector is heuristic. Results must be reported honestly. Injection influence should be evaluated using explicit criteria and paired benign/adversarial inputs; changes in free-form output should not automatically be treated as unsafe influence.

Run each case more than once to estimate variance. Establish baseline metrics and regression thresholds only after collecting initial results. Thresholds should allow documented tolerance for model variability rather than demand exact string matches.

The evaluation harness will run on demand and on a nightly schedule, not as a required PR check initially. It calls a real model, incurs cost, and may be nondeterministic. Its model key should be stored as a repository secret, never committed to source control.

### 9. Characterize SSE Load

The current stream route performs database work on each polling tick for every open connection. Phase 7 will measure the practical impact before Phase 10 changes the architecture.

A small load script will open a configurable number of concurrent streams against a seeded incident and record:

- Number of concurrently open streams.
- Database query rate and, where observable, connection-pool utilization or saturation.
- Stream failures, latency, and resource usage during the test.
- The point at which results degrade beyond an explicitly chosen threshold.

The deliverable is a repeatable script plus a documented approximate connection/query ceiling and the conditions under which it was measured. This is a baseline, not a claim that the current polling design scales indefinitely.

---

## Implementation Checklist

### 1. Test Infrastructure

- [ ] Add `vitest.integration.config.ts` for the real-database suite.
- [ ] Add an `npm run test:integration` script.
- [ ] Add `tests/integration/setup.ts` to validate the test database, verify `pgvector`, and isolate records between tests.
- [ ] Add `tests/integration/fixtures.ts` with organization, incident, and approval-state fixture builders.
- [ ] Add a CI job using a `pgvector/pgvector` service container.
- [ ] Create the vector extension and run `prisma migrate deploy` from an empty database before the integration suite.
- [ ] Ensure the integration suite cannot accidentally target a normal or production database.

### 2. Concurrency and Atomicity

- [ ] Test two concurrent execution claims; exactly one should win.
- [ ] Test concurrent approval versus rejection; exactly one decision should persist.
- [ ] Test concurrent execution completion; exactly one completion event should persist.
- [ ] Test timeout versus execution claim; exactly one valid transition should win.
- [ ] Repeat race scenarios with fresh fixtures and document the iteration count.

### 3. Rollback and Idempotency

- [ ] Implement a test-only fault-injection mechanism for event writes inside transactions.
- [ ] Verify rollback for lifecycle transition, execution claim, execution completion, and manual status update.
- [ ] Verify replay behavior for claim, completion, and `emitAgentEvent`.
- [ ] Verify an unrelated `P2002` unique-constraint error propagates.
- [ ] Assert persisted state and event rows after success, replay, and failure paths.

### 4. Tenant Isolation

- [ ] Verify vector retrieval never returns another organization's chunks.
- [ ] Verify incident, event, and runbook queries are organization-scoped.
- [ ] Include adversarial fixtures with matching data in a second organization.

### 5. Agent Evaluations

- [ ] Create a versioned golden incident set with approximately 30 labeled cases.
- [ ] Create an injection corpus with direct, indirect, and benign examples.
- [ ] Implement `evals/run-evals.ts` to report triage accuracy, proposal validity, tripwire recall, and injection influence rate.
- [ ] Run cases repeatedly and report variance.
- [ ] Establish and document baseline metrics and regression thresholds.
- [ ] Add a nightly and on-demand GitHub Actions workflow using repository secrets for model credentials.

### 6. SSE Load Characterization

- [ ] Add a script for configurable concurrent SSE connections against seeded data.
- [ ] Capture query rate, connection/resource utilization, failures, and latency.
- [ ] Record the approximate connection ceiling and test conditions in the project documentation.

---

## Definition of Done

- [ ] A dedicated integration command runs against a real PostgreSQL database with `pgvector`.
- [ ] CI builds the database schema from an empty database using only the committed migration history.
- [ ] Concurrent claim, approval/rejection, completion, and timeout races verify the expected database outcomes.
- [ ] Fault-injected transactional failures are shown to leave no partial state/event pair.
- [ ] Replay tests verify idempotent persisted outcomes, including handling of unrelated unique-constraint failures.
- [ ] Tenant isolation is verified at the SQL/retrieval boundary.
- [ ] The agent evaluation harness produces repeatable baseline metrics and a nightly regression signal.
- [ ] The SSE load characterization and measured operating conditions are documented.
- [ ] Existing unit tests remain available as a separate fast suite, and both suites are documented with clear commands.

Phase 7 is complete only after the checklist and exit criteria have been met and the results are recorded. Until then, Phase 7 remains **planned/in progress**, not implemented.

---

## What This Phase Will Not Prove

- **Exactly-once external side effects:** Database integration tests cannot prove exactly-once behavior for real infrastructure actions. External execution and provider-side idempotency are Phase 8 work.
- **Third-party service semantics:** Upstash Workflow replay, QStash delivery, and Redis availability remain mocked in this phase. Their behavior is not verified by this database suite.
- **General agent correctness:** A finite golden set and injection corpus can expose regressions, but cannot prove that an agent is generally correct or immune to prompt injection.
- **SSE scalability after redesign:** Phase 7 measures the current polling ceiling. Redis pub/sub or a shared change-feed architecture belongs to Phase 10.
