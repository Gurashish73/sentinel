
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAuth,
  mockMembershipFindUnique,
  mockIncidentFindFirst,
  mockEventFindMany,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockMembershipFindUnique: vi.fn(),
  mockIncidentFindFirst: vi.fn(),
  mockEventFindMany: vi.fn(),
}));

vi.mock("@/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/db", () => ({
  db: {
    membership: {
      findUnique: mockMembershipFindUnique,
    },
    incident: {
      findFirst: mockIncidentFindFirst,
    },
    event: {
      findMany: mockEventFindMany,
    },
  },
}));

import type { NextRequest } from "next/server";
import { GET } from "@/app/api/incidents/[id]/stream/route";

type TestEvent = {
  id: string;
  incidentId: string;
  type: string;
  createdAt: Date;
  streamSequence: number;
  payload?: unknown;
  externalId?: string | null;
};

type EventQuery = {
  where: {
    incidentId: string;
    OR?: Array<Record<string, unknown>>;
    streamSequence?: {
      gt?: number;
    };
  };
  orderBy?: Array<Record<string, string>>;
};

/**
 * Extract the sequence cursor whether it appears directly or in an OR clause.
 */
function getSequenceCursor(args: EventQuery): number | undefined {
  const directCursor = args.where.streamSequence?.gt;

  if (typeof directCursor === "number") {
    return directCursor;
  }

  for (const clause of args.where.OR ?? []) {
    const sequence = clause.streamSequence;

    if (
      sequence !== null &&
      typeof sequence === "object" &&
      !Array.isArray(sequence)
    ) {
      const cursor = (sequence as { gt?: unknown }).gt;

      if (typeof cursor === "number") {
        return cursor;
      }
    }
  }

  return undefined;
}

function makeRequest(
  headers?: Record<string, string>,
): NextRequest {
  return new Request(
    "http://localhost/api/incidents/incident-1/stream",
    { headers },
  ) as NextRequest;
}

async function openStream(request: NextRequest) {
  return GET(request, {
    params: Promise.resolve({ id: "incident-1" }),
  });
}

describe("incident SSE stream", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Isolate event query behavior between tests.
    mockEventFindMany.mockReset();
    mockEventFindMany.mockResolvedValue([]);

    mockAuth.mockResolvedValue({
      user: {
        id: "user-1",
        activeOrgId: "org-1",
      },
    });

    mockMembershipFindUnique.mockResolvedValue({
      userId: "user-1",
      orgId: "org-1",
    });

    mockIncidentFindFirst.mockImplementation(
      async (args: {
        select?: {
          id?: boolean;
          status?: boolean;
          workflowRunId?: boolean;
        };
      }) => {
        if (args.select?.id) {
          return {
            id: "incident-1",
            workflowRunId: "workflow-current",
          };
        }

        if (args.select?.status) {
          return {
            status: "INVESTIGATING",
            workflowRunId: "workflow-current",
          };
        }

        return null;
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers late-visible events in sequence order, not timestamp order", async () => {
    const historicalEvent: TestEvent = {
      id: "event-z",
      incidentId: "incident-1",
      type: "thought",
      createdAt: new Date("2026-01-01T00:00:02.000Z"),
      streamSequence: 10,
    };

    const lateEvent: TestEvent = {
      id: "event-a",
      incidentId: "incident-1",
      type: "evidence_found",
      createdAt: new Date("2026-01-01T00:00:01.000Z"),
      streamSequence: 11,
    };

    const finishedEvent: TestEvent = {
      id: "event-finished",
      incidentId: "incident-1",
      type: "workflow_finished",
      createdAt: new Date("2026-01-01T00:00:03.000Z"),
      streamSequence: 12,
      payload: {
        type: "workflow_finished",
        workflowRunId: "workflow-current",
        reason: "resolved",
        ts: 123,
      },
      externalId:
        "sentinel-agent-event:incident-1:workflow:workflow-current:workflow:finished:resolved",
    };

    const allEvents = [
      historicalEvent,
      lateEvent,
      finishedEvent,
    ];

    let queryCount = 0;

    mockEventFindMany.mockImplementation(async (args: EventQuery) => {
      queryCount += 1;

      if (queryCount === 1) {
        return [historicalEvent];
      }

      const cursor = getSequenceCursor(args) ?? 0;

      return allEvents.filter(
        (event) => event.streamSequence > cursor,
      );
    });

    const response = await openStream(makeRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain(
      "text/event-stream",
    );

    const body = await response.text();

    const historicalIndex = body.indexOf('"id":"event-z"');
    const lateIndex = body.indexOf('"id":"event-a"');
    const finishedIndex = body.indexOf('"id":"event-finished"');

    expect(historicalIndex).toBeGreaterThanOrEqual(0);
    expect(lateIndex).toBeGreaterThanOrEqual(0);
    expect(finishedIndex).toBeGreaterThanOrEqual(0);

    expect(historicalIndex).toBeLessThan(lateIndex);
    expect(lateIndex).toBeLessThan(finishedIndex);

    expect(body.match(/"id":"event-z"/g)).toHaveLength(1);

    expect(body).toContain(
      '"status":"INVESTIGATING","workflowRunId":"workflow-current"',
    );

    expect(body).toContain("event: done\n");
    expect(mockEventFindMany).toHaveBeenCalledTimes(2);

    const pollingArgs = mockEventFindMany.mock.calls[1]?.[0] as EventQuery;

    expect(getSequenceCursor(pollingArgs)).toBe(10);
    expect(pollingArgs.orderBy).toEqual([
      { streamSequence: "asc" },
      { id: "asc" },
    ]);
  });

  it("resumes after Last-Event-ID and recognizes an already-delivered completion", async () => {
    const finishedEvent: TestEvent = {
      id: "event-finished-12",
      incidentId: "incident-1",
      type: "workflow_finished",
      createdAt: new Date("2026-01-01T00:00:03.000Z"),
      streamSequence: 12,
      payload: {
        type: "workflow_finished",
        workflowRunId: "workflow-current",
        reason: "resolved",
        ts: 123,
      },
      externalId:
        "sentinel-agent-event:incident-1:workflow:workflow-current:workflow:finished:resolved",
    };

    mockEventFindMany.mockResolvedValue([finishedEvent]);

    const response = await openStream(
      makeRequest({ "Last-Event-ID": "12" }),
    );

    expect(response.status).toBe(200);

    const body = await response.text();

    expect(mockEventFindMany).toHaveBeenCalledTimes(1);

    const initialQuery = mockEventFindMany.mock.calls[0]?.[0] as EventQuery;

    expect(initialQuery.where.OR?.[0]).toEqual({
      streamSequence: { gt: 12 },
    });

    expect(initialQuery.where.OR?.[1]).toEqual({
      type: "workflow_finished",
      externalId: {
        startsWith:
          "sentinel-agent-event:incident-1:workflow:workflow-current:workflow:finished:",
      },
    });

    expect(body).toContain("event: done\n");
    expect(body).not.toContain('"id":"event-finished-12"');
  });

  it("advances the replay cursor before polling for subsequent events", async () => {
    const replayEvent: TestEvent = {
      id: "event-replay-11",
      incidentId: "incident-1",
      type: "alert_received",
      createdAt: new Date("2026-01-01T00:00:02.000Z"),
      streamSequence: 11,
      payload: {
        type: "alert_received",
        title: "Original alert",
      },
    };

    const finishedEvent: TestEvent = {
      id: "event-finished-12",
      incidentId: "incident-1",
      type: "workflow_finished",
      createdAt: new Date("2026-01-01T00:00:03.000Z"),
      streamSequence: 12,
      payload: {
        type: "workflow_finished",
        workflowRunId: "workflow-current",
        reason: "resolved",
        ts: 123,
      },
      externalId:
        "sentinel-agent-event:incident-1:workflow:workflow-current:workflow:finished:resolved",
    };

    mockEventFindMany
      .mockResolvedValueOnce([replayEvent])
      .mockResolvedValueOnce([finishedEvent]);

    const response = await openStream(makeRequest());
    const body = await response.text();

    expect(body).toContain('"id":"event-replay-11"');
    expect(body).toContain("event: done\n");
    expect(mockEventFindMany).toHaveBeenCalledTimes(2);

    const pollQuery = mockEventFindMany.mock.calls[1]?.[0] as EventQuery;

    expect(getSequenceCursor(pollQuery)).toBe(11);
  });

  it(
    "emits stream_idle when an inactive incident has no workflow completion",
    async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

      mockIncidentFindFirst.mockImplementation(
        async (args: {
          select?: {
            id?: boolean;
            status?: boolean;
            workflowRunId?: boolean;
          };
        }) => {
          if (args.select?.id) {
            return {
              id: "incident-1",
              workflowRunId: null,
            };
          }

          if (args.select?.status) {
            return {
              status: "OPEN",
              workflowRunId: null,
            };
          }

          return null;
        },
      );

      mockEventFindMany.mockResolvedValue([]);

      const response = await openStream(makeRequest());
      const bodyPromise = response.text();

      await vi.advanceTimersByTimeAsync(20_000);

      const body = await bodyPromise;

      expect(body).toContain("event: stream_idle\n");
      expect(body).toContain('"reason":"workflow_inactive"');
      expect(body).toContain('"status":"OPEN"');
      expect(body).toContain('"workflowRunId":null');
      expect(body).not.toContain("event: done\n");
    },
    10_000,
  );

  it("returns 401 when the user is unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const response = await openStream(makeRequest());

    expect(response.status).toBe(401);
    expect(mockMembershipFindUnique).not.toHaveBeenCalled();
    expect(mockIncidentFindFirst).not.toHaveBeenCalled();
  });

  it("returns 403 when the session has no active organization", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1" },
    });

    const response = await openStream(makeRequest());

    expect(response.status).toBe(403);
    expect(mockMembershipFindUnique).not.toHaveBeenCalled();
    expect(mockIncidentFindFirst).not.toHaveBeenCalled();
  });

  it("returns 403 when the user lacks membership in the active organization", async () => {
    mockMembershipFindUnique.mockResolvedValue(null);

    const response = await openStream(makeRequest());

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden");
    expect(mockIncidentFindFirst).not.toHaveBeenCalled();
  });

  it("returns 404 when the incident does not exist in the active organization", async () => {
    mockIncidentFindFirst.mockResolvedValue(null);

    const response = await openStream(makeRequest());

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });

  it("terminates the stream when the incident is deleted during polling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    let statusLookups = 0;

    mockIncidentFindFirst.mockImplementation(
      async (args: {
        select?: {
          id?: boolean;
          status?: boolean;
          workflowRunId?: boolean;
        };
      }) => {
        if (args.select?.id) {
          return {
            id: "incident-1",
            workflowRunId: "workflow-current",
          };
        }

        if (args.select?.status) {
          statusLookups += 1;

          if (statusLookups === 1) {
            return {
              status: "INVESTIGATING",
              workflowRunId: "workflow-current",
            };
          }

          return null;
        }

        return null;
      },
    );

    mockEventFindMany.mockResolvedValue([]);

    const response = await openStream(makeRequest());
    const bodyPromise = response.text();

    await vi.advanceTimersByTimeAsync(2_000);

    const body = await bodyPromise;

    expect(body).toContain("event: status\n");
    expect(body).toContain("event: stream_error\n");
    expect(body).toContain('"message":"Incident no longer exists."');
    expect(body).not.toContain("event: done\n");
  });

  it("terminates the stream when organization membership is revoked", async () => {
    vi.useFakeTimers();

    mockMembershipFindUnique
      .mockResolvedValueOnce({
        userId: "user-1",
        orgId: "org-1",
      })
      .mockResolvedValueOnce(null);

    mockEventFindMany.mockResolvedValue([]);

    const response = await openStream(makeRequest());
    const bodyPromise = response.text();

    await vi.advanceTimersByTimeAsync(2_000);

    const body = await bodyPromise;

    expect(body).toContain("event: stream_error\n");
    expect(body).toContain(
      '"message":"Stream access is no longer authorized."',
    );
    expect(body).not.toContain("event: done\n");
  });

  it(
    "closes at the maximum connection lifetime without reporting workflow completion",
    async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

      // Keep the workflow active so inactivity does not end the stream first.
      mockEventFindMany.mockResolvedValue([]);

      const response = await openStream(makeRequest());
      const bodyPromise = response.text();

      // The route's maximum connection lifetime is 280 seconds.
      await vi.advanceTimersByTimeAsync(282_000);

      const body = await bodyPromise;

      expect(response.status).toBe(200);
      expect(body).toContain("event: status\n");
      expect(body).not.toContain("event: done\n");
      expect(body).not.toContain("event: stream_idle\n");
    },
    10_000,
  );
});
