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
};

type EventQuery = {
  where: {
    incidentId: string;
    createdAt?: {
      gt?: Date;
      gte?: Date;
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

  it("delivers a late-arriving event with the same timestamp without replaying duplicates", async () => {
    const timestamp = new Date("2026-01-01T00:00:00.000Z");

    const historicalEvent: TestEvent = {
      id: "event-z",
      incidentId: "incident-1",
      type: "thought",
      createdAt: timestamp,
    };

    // This event arrives later but sorts before the historical event by ID.
    const lateEvent: TestEvent = {
      id: "event-a",
      incidentId: "incident-1",
      type: "evidence_found",
      createdAt: timestamp,
    };

    // A later terminal event ensures the stream exits cleanly.
    const finishedEvent: TestEvent = {
      id: "event-finished",
      incidentId: "incident-1",
      type: "workflow_finished",
      createdAt: new Date(timestamp.getTime() + 1_000),
    };

    const allEvents = [
      historicalEvent,
      lateEvent,
      finishedEvent,
    ];

    mockEventFindMany.mockImplementation(async (args: EventQuery) => {
      const cursor = args.where.createdAt;

      // Initial replay query.
      if (!cursor) {
        return [historicalEvent];
      }

      // Simulate database filtering so this test catches a regression
      // back to the old strict "createdAt > cursor" polling query.
      if (cursor.gte) {
        return allEvents.filter(
          (event) => event.createdAt >= cursor.gte!,
        );
      }

      if (cursor.gt) {
        return allEvents.filter(
          (event) => event.createdAt > cursor.gt!,
        );
      }

      return allEvents;
    });

    const request = new Request(
      "http://localhost/api/incidents/incident-1/stream",
    );

    const response = await GET(
      request as NextRequest,
      { params: Promise.resolve({ id: "incident-1" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");

    const body = await response.text();

    expect(body).toContain('"id":"event-a"');
    expect(body).toContain('"id":"event-finished"');

    // The historical event is replayed once, despite being returned
    // again by the inclusive polling query.
    expect(body.match(/"id":"event-z"/g)).toHaveLength(1);

    const pollingArgs = mockEventFindMany.mock.calls[1]?.[0] as EventQuery;

    expect(pollingArgs.where.createdAt).toEqual({ gte: timestamp });
    expect(pollingArgs.orderBy).toEqual([
      { createdAt: "asc" },
      { id: "asc" },
    ]);
  });
});
