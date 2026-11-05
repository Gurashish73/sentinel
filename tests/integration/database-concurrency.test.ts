import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const connectionString = process.env.TEST_DATABASE_URL;

if (!connectionString) {
  throw new Error("TEST_DATABASE_URL was not loaded.");
}

const pool = new Pool({
  connectionString,
  max: 10,
  connectionTimeoutMillis: 15_000,
});

let orgId: string;

async function createIncident(options?: {
  status?: string;
  workflowRunId?: string | null;
  workflowAttemptToken?: string | null;
}): Promise<string> {
  const incidentId = `inc_${randomUUID()}`;

  await pool.query(
    `INSERT INTO "Incident" (
      "id",
      "orgId",
      "title",
      "severity",
      "status",
      "workflowRunId",
      "workflowAttemptToken",
      "updatedAt"
    )
    VALUES ($1, $2, $3, 'HIGH', $4, $5, $6, NOW())`,
    [
      incidentId,
      orgId,
      "PostgreSQL concurrency test",
      options?.status ?? "OPEN",
      options?.workflowRunId ?? null,
      options?.workflowAttemptToken ?? randomUUID(),
    ],
  );

  return incidentId;
}

/**
 * Simulates the database portion of the workflow failure callback.
 *
 * It uses the same ownership checks, existing-terminal-event check,
 * compare-and-set predicates, and terminal event keys as the application.
 */
async function runFailureCallback(
  incidentId: string,
  workflowRunId: string,
  attemptToken: string,
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const currentResult = await client.query<{
      status: string;
      workflowRunId: string | null;
      workflowAttemptToken: string | null;
    }>(
      `SELECT
        "status",
        "workflowRunId",
        "workflowAttemptToken"
      FROM "Incident"
      WHERE "id" = $1 AND "orgId" = $2`,
      [incidentId, orgId],
    );

    const current = currentResult.rows[0];

    if (!current) {
      await client.query("COMMIT");
      return;
    }

    if (
      current.workflowAttemptToken !== attemptToken ||
      (current.workflowRunId !== null &&
        current.workflowRunId !== workflowRunId)
    ) {
      await client.query("COMMIT");
      return;
    }

    const terminalPrefix =
      `sentinel-agent-event:${incidentId}:workflow:${workflowRunId}:workflow:finished:`;

    const existingFinished = await client.query(
      `SELECT "id"
       FROM "Event"
       WHERE "orgId" = $1
         AND "incidentId" = $2
         AND "type" = 'workflow_finished'
         AND "externalId" LIKE $3
       LIMIT 1`,
      [orgId, incidentId, `${terminalPrefix}%`],
    );

    if (existingFinished.rowCount && existingFinished.rowCount > 0) {
      await client.query("COMMIT");
      return;
    }

    if (
      current.status === "RESOLVED" &&
      current.workflowRunId !== workflowRunId
    ) {
      await client.query("COMMIT");
      return;
    }

    const activeStatuses = [
      "INVESTIGATING",
      "AWAITING_APPROVAL",
      "EXECUTING",
    ];

    const shouldReopen = activeStatuses.includes(current.status);
    const nextStatus = shouldReopen ? "OPEN" : current.status;

    const updated = await client.query(
      `UPDATE "Incident"
       SET "status" = $1,
           "workflowRunId" = $2,
           "updatedAt" = NOW()
       WHERE "id" = $3
         AND "orgId" = $4
         AND "status" = $5
         AND "workflowRunId" IS NOT DISTINCT FROM $6
         AND "workflowAttemptToken" IS NOT DISTINCT FROM $7
       RETURNING "id"`,
      [
        nextStatus,
        workflowRunId,
        incidentId,
        orgId,
        current.status,
        current.workflowRunId,
        current.workflowAttemptToken,
      ],
    );

    if (updated.rowCount !== 1) {
      await client.query("COMMIT");
      return;
    }

    if (current.status !== nextStatus) {
      await client.query(
        `INSERT INTO "Event" (
          "id",
          "orgId",
          "incidentId",
          "type",
          "payload",
          "actorId",
          "externalId"
        )
        VALUES ($1, $2, $3, 'incident_status_changed', $4::jsonb, NULL, $5)`,
        [
          randomUUID(),
          orgId,
          incidentId,
          JSON.stringify({
            from: current.status,
            to: nextStatus,
            reason: "workflow_failed",
          }),
          `sentinel-agent-event:${incidentId}:workflow:${workflowRunId}:workflow:failure-status-reset`,
        ],
      );
    }

    const reason =
      current.status === "RESOLVED" ? "resolved" : "failed";

    await client.query(
      `INSERT INTO "Event" (
        "id",
        "orgId",
        "incidentId",
        "type",
        "payload",
        "actorId",
        "externalId"
      )
      VALUES ($1, $2, $3, 'workflow_finished', $4::jsonb, NULL, $5)`,
      [
        randomUUID(),
        orgId,
        incidentId,
        JSON.stringify({
          type: "workflow_finished",
          workflowRunId,
          reason,
          ts: Date.now(),
        }),
        `${terminalPrefix}${reason}`,
      ],
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  const result = await pool.query<{
    database_name: string;
    has_trigger: boolean;
    has_cursor: boolean;
    has_attempt_token: boolean;
  }>(
    `SELECT
      current_database() AS database_name,
      EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'Event_assign_stream_sequence_before_insert'
          AND NOT tgisinternal
      ) AS has_trigger,
      to_regclass('public."EventStreamCursor"') IS NOT NULL AS has_cursor,
      EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'Incident'
          AND column_name = 'workflowAttemptToken'
      ) AS has_attempt_token`,
  );

  const database = result.rows[0];

  if (!database || database.database_name !== "sentinel_test") {
    throw new Error("Refusing to run against a non-test database.");
  }

  if (
    !database.has_trigger ||
    !database.has_cursor ||
    !database.has_attempt_token
  ) {
    throw new Error(
      "Required Sentinel migration objects are missing from sentinel_test.",
    );
  }
});

beforeEach(async () => {
  orgId = `org_${randomUUID()}`;

  await pool.query(
    `INSERT INTO "Organization" ("id", "name", "slug")
     VALUES ($1, $2, $3)`,
    [
      orgId,
      "Sentinel Integration Test",
      `sentinel-it-${randomUUID()}`,
    ],
  );
});

afterEach(async () => {
  if (orgId) {
    await pool.query(
      `DELETE FROM "Organization" WHERE "id" = $1`,
      [orgId],
    );
  }
});

afterAll(async () => {
  await pool.end();
});

describe("PostgreSQL concurrency guarantees", () => {
  it("allocates 20 unique, contiguous event sequence numbers under concurrent inserts", async () => {
    const incidentId = await createIncident();

    const eventIds = Array.from(
      { length: 20 },
      () => randomUUID(),
    );

    await Promise.all(
      eventIds.map((eventId, index) =>
        pool.query(
          `INSERT INTO "Event" (
            "id",
            "orgId",
            "incidentId",
            "type",
            "payload"
          )
          VALUES ($1, $2, $3, 'integration_test', $4::jsonb)`,
          [
            eventId,
            orgId,
            incidentId,
            JSON.stringify({ index }),
          ],
        ),
      ),
    );

    const result = await pool.query<{ streamSequence: number }>(
      `SELECT "streamSequence"
       FROM "Event"
       WHERE "incidentId" = $1
       ORDER BY "streamSequence" ASC`,
      [incidentId],
    );

    const sequences = result.rows.map(
      (row) => row.streamSequence,
    );

    expect(sequences).toHaveLength(20);

    expect(sequences).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );

    expect(new Set(sequences).size).toBe(20);
  });

  it("allows only one of two competing workflow runs to claim an attempt", async () => {
    const attemptToken = randomUUID();
    const incidentId = await createIncident({
      status: "OPEN",
      workflowAttemptToken: attemptToken,
    });

    const claim = async (workflowRunId: string) => {
      const result = await pool.query(
        `UPDATE "Incident"
         SET "status" = 'INVESTIGATING',
             "workflowRunId" = $1,
             "updatedAt" = NOW()
         WHERE "id" = $2
           AND "orgId" = $3
           AND "workflowAttemptToken" = $4
           AND "status" IN ('OPEN', 'INVESTIGATING')
           AND (
             "workflowRunId" IS NULL
             OR "workflowRunId" = $1
           )
         RETURNING "id"`,
        [workflowRunId, incidentId, orgId, attemptToken],
      );

      return result.rowCount ?? 0;
    };

    const runA = `run_${randomUUID()}`;
    const runB = `run_${randomUUID()}`;

    const outcomes = await Promise.all([
      claim(runA),
      claim(runB),
    ]);

    expect([...outcomes].sort()).toEqual([0, 1]);

    const current = await pool.query<{
      workflowRunId: string;
      status: string;
    }>(
      `SELECT "workflowRunId", "status"
       FROM "Incident"
       WHERE "id" = $1`,
      [incidentId],
    );

    expect(["INVESTIGATING"]).toContain(current.rows[0]?.status);

    expect([runA, runB]).toContain(
      current.rows[0]?.workflowRunId,
    );
  });

  it("rejects a stale workflow token after a newer retry reserves the incident", async () => {
    const oldToken = randomUUID();
    const newToken = randomUUID();
    const incidentId = await createIncident({
      status: "OPEN",
      workflowAttemptToken: oldToken,
    });

    // Simulate the new retry reserving this incident.
    const reservation = await pool.query(
      `UPDATE "Incident"
       SET "status" = 'INVESTIGATING',
           "workflowRunId" = NULL,
           "workflowAttemptToken" = $1,
           "updatedAt" = NOW()
       WHERE "id" = $2
         AND "orgId" = $3
         AND "status" = 'OPEN'
         AND "workflowRunId" IS NULL
         AND "workflowAttemptToken" = $4
       RETURNING "id"`,
      [newToken, incidentId, orgId, oldToken],
    );

    expect(reservation.rowCount).toBe(1);

    // The old workflow now attempts to claim using its stale token.
    const staleClaim = await pool.query(
      `UPDATE "Incident"
       SET "status" = 'INVESTIGATING',
           "workflowRunId" = $1,
           "updatedAt" = NOW()
       WHERE "id" = $2
         AND "orgId" = $3
         AND "workflowAttemptToken" = $4
         AND "status" IN ('OPEN', 'INVESTIGATING')
         AND (
           "workflowRunId" IS NULL
           OR "workflowRunId" = $1
         )
       RETURNING "id"`,
      [
        `old_run_${randomUUID()}`,
        incidentId,
        orgId,
        oldToken,
      ],
    );

    expect(staleClaim.rowCount).toBe(0);

    const current = await pool.query<{
      status: string;
      workflowRunId: string | null;
      workflowAttemptToken: string;
    }>(
      `SELECT "status", "workflowRunId", "workflowAttemptToken"
       FROM "Incident"
       WHERE "id" = $1`,
      [incidentId],
    );

    expect(current.rows[0]).toMatchObject({
      status: "INVESTIGATING",
      workflowRunId: null,
      workflowAttemptToken: newToken,
    });
  });

  it("allows at most one terminal event from concurrent failure callbacks", async () => {
    const workflowRunId = `run_${randomUUID()}`;
    const attemptToken = randomUUID();

    const incidentId = await createIncident({
      status: "EXECUTING",
      workflowRunId,
      workflowAttemptToken: attemptToken,
    });

    // Deliver two callbacks concurrently for the same failed run.
    await Promise.all([
      runFailureCallback(incidentId, workflowRunId, attemptToken),
      runFailureCallback(incidentId, workflowRunId, attemptToken),
    ]);

    const terminalPrefix =
      `sentinel-agent-event:${incidentId}:workflow:${workflowRunId}:workflow:finished:`;

    const terminalEvents = await pool.query(
      `SELECT "id"
       FROM "Event"
       WHERE "orgId" = $1
         AND "incidentId" = $2
         AND "type" = 'workflow_finished'
         AND "externalId" LIKE $3`,
      [orgId, incidentId, `${terminalPrefix}%`],
    );

    expect(terminalEvents.rowCount).toBe(1);

    const current = await pool.query<{
      status: string;
      workflowRunId: string;
      workflowAttemptToken: string;
    }>(
      `SELECT "status", "workflowRunId", "workflowAttemptToken"
       FROM "Incident"
       WHERE "id" = $1`,
      [incidentId],
    );

    expect(current.rows[0]).toMatchObject({
      status: "OPEN",
      workflowRunId,
      workflowAttemptToken: attemptToken,
    });
  });
});
