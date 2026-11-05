# Phase 7: Verification & Test Rigor

## Status

**In progress — integration-test foundations were added during Phase 6; the remaining Phase 7 verification work is planned.** This document tracks the work needed to turn the initial database checks into repeatable, application-level verification. Checklist items are marked complete only where the implementation and result have already been reported and verified.

## Overview

Phases 2–6 introduced important reliability controls: atomic execution claims, proposal-bound human approval, compare-and-set lifecycle transitions, workflow-attempt fencing, stable event identities, and commit-ordered event streaming.

Phase 6 also introduced a separate PostgreSQL integration-test configuration and an isolated Neon test database. That is an important first step, but it does not close the full verification gap. Some current integration tests exercise database predicates directly rather than invoking the production application path, and the failure-callback test reproduces the transaction behavior rather than invoking the actual Upstash Workflow failure handler. These tests provide evidence about the database behavior they execute; they should not be described as complete end-to-end verification of the corresponding route or provider callback.

Phase 7 will extend that foundation. It will verify important concurrency and rollback guarantees through the real application/database boundary, reproduce the migration setup in CI from an empty PostgreSQL database, test tenant isolation at the SQL and retrieval boundaries, build a finite agent-evaluation harness, and characterize the current SSE polling load.

This phase focuses on evidence for existing behavior rather than adding product features.

## Current Baseline from Phase 6

The following work is already present and should be extended rather than recreated:

- `vitest.config.ts` separates the fast unit suite from the integration suite.
- `vitest.integration.config.ts` runs tests under `tests/integration/`.
- `npm run test:integration` invokes the integration configuration.
- `tests/integration/setup.ts` loads local environment configuration and validates `TEST_DATABASE_URL`. The guard requires a direct Neon hostname ending in `.neon.tech`, rejects a `-pooler` hostname, and requires the database name to be exactly `sentinel_test`.
- A separate Neon project/database named `Sentinel-Test` / `sentinel_test` was created for integration testing. All 10 tracked Prisma migrations were applied successfully to that test database. The production database URL was not changed as part of that migration run.
- Four PostgreSQL integration checks were reported passing:
  1. Event-sequence trigger behavior with 20 inserted events, checking unique and contiguous `streamSequence` values.
  2. Workflow-claim contention using the database claim predicate directly.
  3. Stale-attempt rejection using the database predicate directly.
  4. Concurrent failure-callback transaction behavior reproduced in the test, checking that only one terminal event remains. This test does **not** invoke the actual Upstash `failureFunction` handler.
- The Phase 6 close-out validation reported `npm test` passing 200 tests across 29 files, `npm run test:integration` passing 4 tests, and successful typecheck, lint, production build, and `git diff --check`.

These are the starting point, not the Phase 7 exit criteria. In particular, the claim-contention and stale-attempt tests need application-path coverage, and the failure-callback behavior needs a test that invokes the real handler boundary or a deliberately extracted production handler function.

## Goals

- Verify database-level concurrency and transaction guarantees against real PostgreSQL through production application operations.
- Prove the committed Prisma migration history can build a working schema from an empty database in CI.
- Test organization isolation at SQL and retrieval boundaries, including raw SQL vector retrieval.
- Verify rollback when an event/audit write fails inside a real transaction.
- Verify persisted idempotency and replay behavior rather than relying only on mocked call sequences.
- Measure agent behavior on a versioned set of representative incidents and prompt-injection examples.
- Record the practical connection/query ceiling of the current SSE polling implementation.
- Keep fast unit tests separate from slower database integration and model-evaluation suites.

## Out of Scope

- Implementing real infrastructure execution; that is Phase 8.
- Replacing mocked log retrieval with a real provider; that is Phase 9.
- Replacing the SSE polling architecture; Phase 7 measures its limitations, while scaling work belongs to Phase 10.
- Treating agent evaluations as proof of general correctness. The harness will measure regressions on a finite dataset only.
- Proving third-party Upstash, QStash, Redis, or Gemini service guarantees through PostgreSQL-only integration tests.

---

## Developer Notes & Architecture Decisions

### 1. Keep Unit and Integration Tests Separate

The existing mocked unit tests remain the fast feedback suite. PostgreSQL integration tests run through a separate Vitest configuration and use a dedicated test database. Preserve the current separation; do not make the ordinary `npm test` command depend on Neon or another external database.

Current structure:

```text
vitest.config.ts                 # fast unit-test configuration
vitest.integration.config.ts     # PostgreSQL integration-test configuration
tests/
  integration/
    setup.ts
    *.integration.test.ts
```

`npm run test:integration` is already present. Add fixture helpers only where they reduce duplication and keep their behavior explicit. Do not assume a shared `fixtures.ts` file exists until it is added.

The local integration setup currently guards against using an arbitrary or pooled database URL by requiring the dedicated `sentinel_test` database on a direct Neon endpoint. Keep that fail-fast protection. CI should use its own ephemeral PostgreSQL service and test-only credentials rather than the developer's Neon database.

### 2. Reproduce the Migration History in CI

The integration CI job should use a `pgvector/pgvector` service container rather than a developer's database or a hosted Neon environment.

The job should:

1. Start with an ephemeral, empty PostgreSQL database.
2. Create the `vector` extension before applying migrations, matching the project's database setup requirements.
3. Apply the committed migration history with `prisma migrate deploy`.
4. Run the PostgreSQL integration suite against that database.
5. Fail if extension creation, migration application, or integration verification fails.
6. Destroy the service database at the end of the job.

Upstash Redis, QStash, and Gemini should remain mocked in this database tier unless a separate provider-contract test is deliberately introduced. The integration job should not require production service credentials. CI database credentials must be short-lived or test-only and must never point to production.

The local Neon migration run proves that the tracked migrations were applied to the isolated test database. It does not replace the CI check that starts from a fresh, empty database on every run.

### 3. Isolate Test Data Safely

Integration tests must not rely on shared state or on test execution order. Add a cleanup strategy that is compatible with the actual schema and foreign-key relationships. A truncate helper may use `CASCADE`, but it must run only after the test database guard succeeds.

Any cleanup operation must be impossible to run against the normal development or production database accidentally. Do not weaken or bypass the current `TEST_DATABASE_URL` checks for convenience.

Fixture builders such as `createOrg`, `createIncident`, and `createAwaitingApprovalIncident` may be added to `tests/integration/fixtures.ts` when needed. Fixtures should create the minimum records required for each case, return the created identifiers, and avoid relying on data left by another test.

### 4. Test Real Concurrent Races Through Application Paths

Concurrency tests must exercise the production database operations or extracted production functions used by the application. Executing a copy of a SQL predicate in a test is useful for validating that predicate, but it does not prove the route or application function passes the correct values, handles the result correctly, or emits the required audit event.

Build on the existing Phase 6 tests as follows:

- **Workflow claim contention:** Invoke the actual workflow-claim operation concurrently for the same incident and workflow attempt. Verify that only the permitted attempt acquires ownership, and that a stale or superseded attempt cannot enter the agent pipeline. Include the current attempt-token and workflow-run guards.
- **Stale attempt:** Invoke the production claim path with an outdated attempt token after a newer retry has reserved the incident. Verify that the stale delivery is rejected and cannot modify the newer attempt's state.
- **Retry reservation:** Race two real retry reservations for the same incident. Exactly one compare-and-set reservation should win; the losing operation should report the established concurrent-change result.
- **Double execution claim:** Run two `claimApprovedExecution` operations concurrently for the same proposal. Exactly one should win the `AWAITING_APPROVAL → EXECUTING` transition, with exactly one `action_execution_claimed` event.
- **Approve versus reject:** Run the actual approval/rejection operation concurrently for the same proposal. Exactly one decision should be persisted; the losing operation should return or throw the existing conflicting-decision result.
- **Double completion:** Run two `completeApprovedExecution` operations concurrently. Exactly one `action_executed` event and one `RESOLVED` transition should be persisted.
- **Timeout versus claim:** Race the current workflow-timeout transition against an execution claim. Exactly one valid transition should win, and the losing operation should report the established superseded/conflict outcome.

Before implementing each case, verify the current function signatures, event names, transition rules, and intended loser semantics in source. Do not restore or write tests for removed APIs such as the former `updateIncidentStatus` action. Target the currently implemented guarded transition path instead.

Run race scenarios repeatedly (for example, 25 iterations) with freshly seeded records. Repetition increases the chance of exposing ordering bugs, but a passing test must not be described as a formal proof of every possible interleaving.

### 5. Verify Rollback Through Fault Injection

A key invariant is that a transaction must not leave incident state updated when its associated audit/event write fails. This requires a real database transaction and a fault that occurs from inside the transaction being tested. An error thrown before the transaction begins does not prove rollback.

Use a test-only Prisma extension, transaction-aware injected dependency, or another mechanism compatible with the installed Prisma version. The test must make the event/audit operation fail inside the same transaction that performed the state update.

Planned cases:

- The current guarded lifecycle-transition transaction when its event/audit write fails.
- `claimApprovedExecution` when its claim-event write fails.
- `completeApprovedExecution` when its execution-event write fails.
- The actual workflow failure-handler transaction, if its production implementation owns transactional state/event writes.

For each case, assert that the operation fails and that the persisted database state remains unchanged. Also assert that no partial event, decision, or completion record remains where the operation is expected to be atomic.

The former `updateIncidentStatus` action was removed during Phase 6 because it was unused and did not provide a live transition path. Do not include it as a Phase 7 rollback target. First identify the current production transaction boundary and test that boundary.

### 6. Verify Idempotency and Replay Behavior

Durable workflow steps may be replayed. Integration tests should invoke the relevant production operation more than once and query persisted rows after each invocation.

Planned cases:

- Replayed workflow claim returns the established claim/replay result without creating a duplicate claim event.
- Replayed execution claim returns the established result without creating a second claim event.
- Replayed completion returns the established completion result without creating a second execution event.
- Replaying `emitAgentEvent` with the same deduplication key returns `false` and leaves exactly one matching event.
- A `P2002` caused by a different unique constraint is not accidentally swallowed as a deduplication success.
- Repeated invocation of the actual workflow failure handler does not produce duplicate terminal events or overwrite a newer workflow attempt.

Tests must verify persisted rows and resulting incident state. Mock call counts alone are not sufficient evidence for database idempotency. Where a third-party delivery wrapper cannot be invoked in this tier, clearly identify the production function being tested and the provider behavior that remains outside the test's scope.

### 7. Verify Tenant Isolation at the Database Boundary

Tenant isolation must be tested where the filtering actually occurs, especially in raw SQL vector retrieval.

Planned tests:

- Seed two organizations with equivalent runbook content and embeddings. Verify `retrieveRelevantChunks(orgA, ...)` never returns a chunk belonging to organization B.
- Verify incident, event, and runbook retrieval paths return only records scoped to the requested organization.
- Where practical, execute the raw SQL or query helper directly so the test exercises the actual `WHERE` clauses rather than merely checking that a mocked method received an `orgId` argument.
- Include an adversarial fixture where matching content exists in another organization; otherwise, an accidentally missing organization predicate could go undetected.

The test should assert both the returned rows and their organization ownership. Do not infer isolation solely from the absence of an error.

### 8. Build an Agent Evaluation Harness

Agent behavior is probabilistic, so Phase 7 will measure it across a repeatable dataset instead of relying only on canned LLM mocks.

Proposed structure:

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

The evaluation harness should run on demand and on a nightly schedule, not as a required pull-request check initially. It calls a real model, incurs cost, and may be nondeterministic. Its model key must be stored as a repository secret, never committed to source control. This evaluation tier must remain separate from the PostgreSQL integration job.

### 9. Characterize SSE Load

The current stream route performs database work on each polling tick for every open connection. Phase 7 will measure the practical impact before Phase 10 changes the architecture.

A small load script will open a configurable number of concurrent streams against a seeded incident and record:

- Number of concurrently open streams.
- Database query rate and, where observable, connection-pool utilization or saturation.
- Stream failures, latency, and resource usage during the test.
- The point at which results degrade beyond an explicitly chosen threshold.

The deliverable is a repeatable script plus a documented approximate connection/query ceiling and the conditions under which it was measured. This is a baseline, not a claim that the current polling design scales indefinitely. Respect the route's bounded connection lifetime and reconnect behavior when designing the load script so the measurements reflect the deployed lifecycle.

---

## Implementation Checklist

### 1. Test Infrastructure and CI

- [x] Add `vitest.integration.config.ts` for the PostgreSQL integration suite.
- [x] Add the `npm run test:integration` command.
- [x] Add `tests/integration/setup.ts` with a fail-fast `TEST_DATABASE_URL` guard for the dedicated direct Neon `sentinel_test` database.
- [x] Create a separate Neon `Sentinel-Test` database and successfully apply the 10 tracked Prisma migrations.
- [ ] Add reusable integration fixtures and a safe, foreign-key-aware cleanup strategy.
- [ ] Add a CI job using an ephemeral `pgvector/pgvector` service container.
- [ ] Create the `vector` extension and run `prisma migrate deploy` from an empty CI database before the integration suite.
- [ ] Ensure the integration suite cannot accidentally target a normal development or production database in local and CI environments.
- [ ] Run the PostgreSQL integration suite in CI independently of the fast unit suite.

### 2. Concurrency and Attempt Ownership

- [x] Add an initial PostgreSQL event-sequence test covering 20 event inserts and unique, contiguous `streamSequence` allocation.
- [x] Add an initial database-level workflow-claim predicate contention test.
- [x] Add an initial database-level stale-attempt predicate test.
- [ ] Exercise workflow claim contention through the production application path.
- [ ] Exercise stale attempt-token rejection through the production application path.
- [ ] Test two concurrent retry reservations; exactly one compare-and-set reservation should win.
- [ ] Test two concurrent execution claims; exactly one should win.
- [ ] Test concurrent approval versus rejection; exactly one decision should persist.
- [ ] Test concurrent execution completion; exactly one completion event should persist.
- [ ] Test timeout versus execution claim; exactly one valid transition should win.
- [ ] Repeat race scenarios with fresh fixtures and document the iteration count.

### 3. Rollback and Idempotency

- [ ] Implement a transaction-aware, test-only fault-injection mechanism for event/audit writes.
- [ ] Verify rollback for the current guarded lifecycle transition transaction.
- [ ] Verify rollback for execution claim and completion transactions.
- [ ] Verify rollback for the actual workflow failure-handler transaction, where applicable.
- [ ] Verify replay behavior for workflow claim, execution claim, completion, and `emitAgentEvent`.
- [ ] Exercise the actual production failure-handler boundary and verify duplicate delivery does not create duplicate terminal events or overwrite a newer attempt.
- [ ] Verify an unrelated `P2002` unique-constraint error propagates.
- [x] Add an initial failure-callback transaction reproduction test; retain its limitation in the documentation until the real handler is covered.
- [ ] Assert persisted state and event rows after success, replay, concurrency, and failure paths.

### 4. Tenant Isolation

- [ ] Verify vector retrieval never returns another organization's chunks.
- [ ] Verify incident, event, and runbook queries are organization-scoped at the SQL/retrieval boundary.
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

- [ ] CI can build the database schema from an empty PostgreSQL database with `pgvector`, using only the committed migration history.
- [ ] Unit and integration suites run separately, with clear commands and no accidental dependency on a production database.
- [ ] Production application paths verify workflow claim, stale-attempt, retry-reservation, execution-claim, approval/rejection, completion, and timeout race behavior against PostgreSQL.
- [ ] Fault-injected transactional failures are shown to leave no partial state/event pair.
- [ ] Replay tests verify persisted idempotent outcomes, including handling of unrelated unique-constraint failures.
- [ ] The actual failure-handler boundary is covered, or the remaining provider boundary is explicitly documented as unverified.
- [ ] Tenant isolation is verified at the SQL/retrieval boundary with adversarial cross-organization fixtures.
- [ ] The agent evaluation harness produces repeatable baseline metrics and a nightly regression signal.
- [ ] The SSE load characterization and measured operating conditions are documented.
- [ ] Results, limitations, and test commands are recorded in project documentation.

Phase 7 is complete only after the remaining checklist and exit criteria have been met and the results are recorded. Until then, Phase 7 remains **in progress**; the Phase 6 integration-test foundation must not be presented as completion of the broader Phase 7 verification plan.

---

## What This Phase Will Not Prove

- **Exactly-once external side effects:** Database integration tests cannot prove exactly-once behavior for real infrastructure actions. External execution and provider-side idempotency are Phase 8 work.
- **Third-party service semantics:** Upstash Workflow replay, QStash delivery, and Redis availability are not proven by PostgreSQL-only tests. Any mocked service behavior must be identified as mocked, and provider guarantees require a separate contract or integration test.
- **General agent correctness:** A finite golden set and injection corpus can expose regressions, but cannot prove that an agent is generally correct or immune to prompt injection.
- **SSE scalability after redesign:** Phase 7 measures the current polling ceiling. Redis pub/sub or a shared change-feed architecture belongs to Phase 10.
