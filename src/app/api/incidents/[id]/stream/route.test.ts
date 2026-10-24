import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("incident SSE stream", () => {
  beforeEach(() => {
    vi.clearAllMocks();

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
      async (args: { select?: { id?: boolean; status?: boolean; workflowRunId?: boolean } }) => {
        if (args.select?.id) {
          return { id: "incident-1", workflowRunId: "workflow-current" };
        }

        if (args.select?.status) {
          return { status: "INVESTIGATING", workflowRunId: "workflow-current" };
        }

        return null;
      },
    );
  });

  it("delivers a late-visible event with an older timestamp in sequence order", async () => {
    const historicalEvent: TestEvent = {
      id: "event-z",
      incidentId: "incident-1",
      type: "thought",
      createdAt: new Date("2026-01-01T00:00:02.000Z"),
      streamSequence: 10,
    };

    // This event becomes visible later, despite its older createdAt timestamp.
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
      payload: { type: "workflow_finished", workflowRunId: "workflow-current", reason: "resolved", ts: 123 },
      externalId: "sentinel-agent-event:incident-1:workflow:workflow-current:workflow:finished:resolved",
    };

    const allEvents = [
      historicalEvent,
      lateEvent,
      finishedEvent,
    ];

    mockEventFindMany.mockImplementation(async (args: EventQuery) => {
      // Initial history replay.
      if (!args.where.streamSequence) {
        return [historicalEvent];
      }

      const cursor = args.where.streamSequence.gt ?? -Infinity;

      // Simulate the database's strict sequence-cursor filtering.
      return allEvents.filter(
        (event) => event.streamSequence > cursor,
      );
    });

    const request = new Request(
      "http://localhost/api/incidents/incident-1/stream",
    );

    const response = await GET(
      request as NextRequest,
      { params: Promise.resolve({ id: "incident-1" }) },
    );

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

    // Delivery follows the sequence, not the event's wall-clock timestamp.
    expect(historicalIndex).toBeLessThan(lateIndex);
    expect(lateIndex).toBeLessThan(finishedIndex);

    // The historical event is delivered exactly once.
    expect(body.match(/"id":"event-z"/g)).toHaveLength(1);

    const pollingArgs = mockEventFindMany.mock.calls[1]?.[0] as EventQuery;

    expect(pollingArgs.where.streamSequence).toEqual({ gt: 10 });
    expect(pollingArgs.orderBy).toEqual([
      { streamSequence: "asc" },
      { id: "asc" },
    ]);
  });

  it("resumes after Last-Event-ID and recognizes a completion whose sequence was already delivered", async () => {
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

    const request = new Request(
      "http://localhost/api/incidents/incident-1/stream",
      { headers: { "Last-Event-ID": "12" } },
    );

    const response = await GET(
      request as NextRequest,
      { params: Promise.resolve({ id: "incident-1" }) },
    );

    expect(response.status).toBe(200);
    const body = await response.text();

    expect(mockEventFindMany).toHaveBeenCalledTimes(1);
    const initialQuery = mockEventFindMany.mock.calls[0]?.[0] as EventQuery;
    expect(initialQuery.where.OR?.[0]).toEqual({ streamSequence: { gt: 12 } });
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

  it("advances the replay cursor before polling for later events", async () => {
    const replayEvent: TestEvent = {
      id: "event-replay-11",
      incidentId: "incident-1",
      type: "alert_received",
      createdAt: new Date("2026-01-01T00:00:02.000Z"),
      streamSequence: 11,
      payload: { type: "alert_received", title: "Original alert" },
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

    const request = new Request(
      "http://localhost/api/incidents/incident-1/stream",
    );
    const response = await GET(
      request as NextRequest,
      { params: Promise.resolve({ id: "incident-1" }) },
    );
    const body = await response.text();

    expect(body).toContain('"id":"event-replay-11"');
    expect(body).toContain("event: done\n");
    expect(mockEventFindMany).toHaveBeenCalledTimes(2);
    const pollQuery = mockEventFindMany.mock.calls[1]?.[0] as EventQuery;
    expect(pollQuery.where.streamSequence).toEqual({ gt: 11 });
  });
});
