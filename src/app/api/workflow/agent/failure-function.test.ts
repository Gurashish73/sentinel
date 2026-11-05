import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  serveCalls: vi.fn(),
  transaction: vi.fn(),
  incidentFindFirst: vi.fn(),
  incidentUpdateMany: vi.fn(),
  eventFindFirst: vi.fn(),
  eventCreate: vi.fn(),
}));

vi.mock("@upstash/workflow/nextjs", () => ({
  serve: (handler: unknown, options?: unknown) => {
    mocks.serveCalls(handler, options);
    return { POST: handler };
  },
}));

vi.mock("@/lib/db", () => ({
  db: { $transaction: mocks.transaction },
}));

vi.mock("@/agents/triage", () => ({ runTriage: vi.fn() }));
vi.mock("@/agents/diagnosis", () => ({ runDiagnosis: vi.fn() }));
vi.mock("@/agents/remediation", () => ({ proposeRemediation: vi.fn() }));
vi.mock("@/lib/incident-transition", () => ({
  transitionIncidentWithEvent: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  orgExecutionLimiter: { limit: vi.fn() },
}));
vi.mock("@/lib/proposal", () => ({ approvalEventId: vi.fn() }));
vi.mock("@/lib/execution-lifecycle", () => ({
  claimApprovedExecution: vi.fn(),
  completeApprovedExecution: vi.fn(),
}));
vi.mock("@/lib/emit-agent-event", () => ({
  emitAgentEvent: vi.fn(),
  dedupeExternalId: (incidentId: string, key: string) =>
    `sentinel-agent-event:${incidentId}:${key}`,
  workflowEventDedupeKey: (runId: string, scope: string, name: string) =>
    `${scope}:${runId}:${scope}:${name}`,
}));

// Import the route to register its workflow failure callback.
import "@/app/api/workflow/agent/route";

type FailureArgs = {
  context: { requestPayload: unknown; workflowRunId: string };
  failStatus: string;
};

type ServeOptions = {
  failureFunction?: (args: FailureArgs) => Promise<void> | void;
};

type IncidentSnapshot = {
  status: string;
  workflowRunId: string | null;
  workflowAttemptToken: string | null;
};

type RecordedEvent = {
  orgId: string;
  incidentId: string;
  type: string;
  externalId?: string;
  payload?: unknown;
  actorId?: string | null;
};

let currentIncident: IncidentSnapshot | null;
let storedEvents: RecordedEvent[];

const txClient = {
  incident: {
    findFirst: mocks.incidentFindFirst,
    updateMany: mocks.incidentUpdateMany,
  },
  event: {
    findFirst: mocks.eventFindFirst,
    create: mocks.eventCreate,
  },
};

// Retrieve and safely narrow the callback registered with serve().
const registeredOptions = mocks.serveCalls.mock.calls[0]?.[1] as
  | ServeOptions
  | undefined;

const registeredFailureFunction = registeredOptions?.failureFunction;

if (typeof registeredFailureFunction !== "function") {
  throw new Error(
    "Workflow failureFunction was not registered. Ensure serve() receives the failureFunction option.",
  );
}

const failureFunction: NonNullable<ServeOptions["failureFunction"]> =
  registeredFailureFunction;

function setIncident(
  status: string,
  workflowRunId: string | null = "run-1",
  workflowAttemptToken: string | null = "token-1",
) {
  currentIncident = {
    status,
    workflowRunId,
    workflowAttemptToken,
  };
}

async function invokeFailure(options?: {
  incidentId?: string;
  orgId?: string;
  attemptToken?: string;
  workflowRunId?: string;
}) {
  await failureFunction({
    context: {
      requestPayload: {
        incidentId: options?.incidentId ?? "inc-1",
        orgId: options?.orgId ?? "org-1",
        attemptToken: options?.attemptToken ?? "token-1",
      },
      workflowRunId: options?.workflowRunId ?? "run-1",
    },
    failStatus: "500",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  storedEvents = [];
  setIncident("INVESTIGATING");

  mocks.incidentFindFirst.mockImplementation(async () =>
    currentIncident ? { ...currentIncident } : null,
  );

  mocks.incidentUpdateMany.mockImplementation(async (input: unknown) => {
    const args = input as {
      where: {
        id: string;
        orgId: string;
        status: string;
        workflowRunId: string | null;
        workflowAttemptToken: string | null;
      };
      data: {
        status: string;
        workflowRunId: string | null;
      };
    };

    if (
      !currentIncident ||
      currentIncident.status !== args.where.status ||
      currentIncident.workflowRunId !== args.where.workflowRunId ||
      currentIncident.workflowAttemptToken !==
        args.where.workflowAttemptToken
    ) {
      return { count: 0 };
    }

    currentIncident = {
      ...currentIncident,
      status: args.data.status,
      workflowRunId: args.data.workflowRunId,
    };

    return { count: 1 };
  });

  mocks.eventFindFirst.mockImplementation(async (input: unknown) => {
    const args = input as {
      where: {
        orgId: string;
        incidentId: string;
        type: string;
        externalId: { startsWith: string };
      };
    };

    const found = storedEvents.some(
      (event) =>
        event.orgId === args.where.orgId &&
        event.incidentId === args.where.incidentId &&
        event.type === args.where.type &&
        (event.externalId ?? "").startsWith(
          args.where.externalId.startsWith,
        ),
    );

    return found ? { id: "existing-terminal-event" } : null;
  });

  mocks.eventCreate.mockImplementation(async (input: unknown) => {
    const args = input as { data: RecordedEvent };
    storedEvents.push(args.data);

    return { id: `event-${storedEvents.length}` };
  });

  mocks.transaction.mockImplementation(async (callback: unknown) => {
    if (typeof callback !== "function") {
      throw new Error("Expected a transaction callback.");
    }

    return (
      callback as (client: typeof txClient) => Promise<unknown>
    )(txClient);
  });
});

describe("workflow failureFunction", () => {
  it("reopens an exhausted INVESTIGATING workflow and records a failed terminal event", async () => {
    setIncident("INVESTIGATING");

    await invokeFailure();

    expect(currentIncident?.status).toBe("OPEN");

    expect(storedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "incident_status_changed",
          payload: expect.objectContaining({
            from: "INVESTIGATING",
            to: "OPEN",
            reason: "workflow_failed",
          }),
        }),
        expect.objectContaining({
          type: "workflow_finished",
          payload: expect.objectContaining({
            workflowRunId: "run-1",
            reason: "failed",
          }),
        }),
      ]),
    );
  });

  it("reopens EXECUTING only when the failed attempt still owns the incident", async () => {
    setIncident("EXECUTING", "run-1", "token-1");

    await invokeFailure();

    expect(currentIncident?.status).toBe("OPEN");
    expect(mocks.incidentUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale attempt token without changing status or emitting events", async () => {
    setIncident("INVESTIGATING", "run-1", "token-current");

    await invokeFailure({ attemptToken: "token-stale" });

    expect(currentIncident?.status).toBe("INVESTIGATING");
    expect(mocks.incidentUpdateMany).not.toHaveBeenCalled();
    expect(storedEvents).toHaveLength(0);
  });

  it("ignores a failure callback from a different workflow run", async () => {
    setIncident("EXECUTING", "run-current", "token-1");

    await invokeFailure({ workflowRunId: "run-stale" });

    expect(currentIncident?.status).toBe("EXECUTING");
    expect(mocks.incidentUpdateMany).not.toHaveBeenCalled();
    expect(storedEvents).toHaveLength(0);
  });

  it("never reopens a RESOLVED incident", async () => {
    setIncident("RESOLVED", "run-1", "token-1");

    await invokeFailure();

    expect(currentIncident?.status).toBe("RESOLVED");
    expect(storedEvents).toHaveLength(1);

    expect(storedEvents[0]).toEqual(
      expect.objectContaining({
        type: "workflow_finished",
        payload: expect.objectContaining({
          workflowRunId: "run-1",
          reason: "resolved",
        }),
      }),
    );
  });

  it("does not create duplicate terminal events if the callback is delivered repeatedly", async () => {
    setIncident("INVESTIGATING", "run-1", "token-1");

    await invokeFailure();
    await invokeFailure();

    const terminalEvents = storedEvents.filter(
      (event) => event.type === "workflow_finished",
    );

    expect(currentIncident?.status).toBe("OPEN");
    expect(terminalEvents).toHaveLength(1);
    expect(mocks.eventCreate).toHaveBeenCalledTimes(2);
  });
});