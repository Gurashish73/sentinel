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
};

type EventQuery = {
  where: {
    incidentId: string;
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
      async (args: { select?: { id?: boolean; status?: boolean } }) => {
        if (args.select?.id) {
          return { id: "incident-1" };
        }

        if (args.select?.status) {
          return { status: "INVESTIGATING" };
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
});
