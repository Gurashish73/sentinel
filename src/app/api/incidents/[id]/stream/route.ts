import "server-only";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import type { NextRequest } from "next/server";

// Force Node.js runtime. Prisma's pg driver does not support Edge environments.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hard ceiling on a single connection. Active streams can reconnect using
// their last delivered sequence ID.
export const maxDuration = 300;

const POLL_INTERVAL_MS = 1500;
const MAX_STREAM_MS = 280_000;
const INACTIVE_STREAM_GRACE_MS = 15_000;

const ACTIVE_WORKFLOW_STATUSES = new Set<string>([
  "INVESTIGATING",
  "AWAITING_APPROVAL",
  "EXECUTING",
]);

function parseLastEventId(value: string | null): number {
  if (value === null || !/^\d+$/.test(value)) return 0;

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function isCurrentWorkflowFinished(
  event: {
    type: string;
    payload: unknown;
    externalId?: string | null;
  },
  incidentId: string,
  workflowRunId: string | null,
): boolean {
  if (event.type !== "workflow_finished" || !workflowRunId) {
    return false;
  }

  const payload = event.payload;

  if (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload)
  ) {
    const payloadRunId = (payload as Record<string, unknown>).workflowRunId;

    if (typeof payloadRunId === "string") {
      return payloadRunId === workflowRunId;
    }
  }

  // Backwards compatibility for terminal events created before workflowRunId
  // was included in the JSON payload.
  return (
    event.externalId?.startsWith(
      `sentinel-agent-event:${incidentId}:workflow:${workflowRunId}:workflow:finished:`,
    ) ?? false
  );
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: incidentId } = await params;
  const session = await auth();

  if (!session?.user) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!session.user.activeOrgId) {
    return new Response("No active organization", { status: 403 });
  }

  // Preserve the validated organization ID inside the stream closures.
  const orgId = session.user.activeOrgId;
  const userId = session.user.id;

  const membership = await db.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
  });

  if (!membership) {
    return new Response("Forbidden", { status: 403 });
  }

  const incident = await db.incident.findFirst({
    where: { id: incidentId, orgId },
    select: { id: true, workflowRunId: true },
  });

  if (!incident) {
    return new Response("Not found", { status: 404 });
  }

  let closed = false;

  const onRequestAbort = () => {
    closed = true;
  };

  if (req.signal.aborted) {
    closed = true;
  } else {
    req.signal.addEventListener("abort", onRequestAbort, { once: true });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const startedAt = Date.now();

      // The database assigns a commit-ordered sequence to each incident event.
      let lastSeenSequence = parseLastEventId(
        req.headers.get("last-event-id"),
      );

      // Defensive deduplication in case an event is returned more than once.
      const seenEventIds = new Set<string>();

      let currentWorkflowRunId: string | null = incident.workflowRunId;
      let lastSentStatus: string | null = null;
      let lastSentWorkflowRunId: string | null | undefined;
      let inactiveSince: number | null = null;

      function send(event: string | null, data: unknown, id?: number) {
        if (closed) return;

        const idLine =
          typeof id === "number" && Number.isSafeInteger(id)
            ? `id: ${id}\n`
            : "";

        const prefix = event ? `event: ${event}\n` : "";

        controller.enqueue(
          encoder.encode(
            `${idLine}${prefix}data: ${JSON.stringify(data)}\n\n`,
          ),
        );
      }

      // Re-verify organization membership every tick so revoked access
      // terminates the stream.
      async function stillAuthorized(): Promise<boolean> {
        const currentMembership = await db.membership.findUnique({
          where: { userId_orgId: { userId, orgId } },
        });

        return !!currentMembership;
      }

      // Refresh status and workflow ownership together. Sending workflowRunId
      // lets clients identify which run currently owns the incident.
      async function sendStatusIfChanged(): Promise<{
        status: string;
        workflowRunId: string | null;
      } | null> {
        const current = await db.incident.findFirst({
          where: { id: incidentId, orgId },
          select: { status: true, workflowRunId: true },
        });

        if (!current) return null;

        currentWorkflowRunId = current.workflowRunId;

        if (
          current.status !== lastSentStatus ||
          current.workflowRunId !== lastSentWorkflowRunId
        ) {
          lastSentStatus = current.status;
          lastSentWorkflowRunId = current.workflowRunId;

          send("status", {
            status: current.status,
            workflowRunId: current.workflowRunId,
          });
        }

        return {
          status: current.status,
          workflowRunId: current.workflowRunId,
        };
      }

      // Include terminal events for the current run even when their sequence
      // is not greater than Last-Event-ID. This allows a reconnecting client to
      // learn that the current workflow has already finished.
      function currentRunFinishedFilter() {
        if (!currentWorkflowRunId) return [];

        return [
          {
            type: "workflow_finished",
            externalId: {
              startsWith: `sentinel-agent-event:${incidentId}:workflow:${currentWorkflowRunId}:workflow:finished:`,
            },
          },
        ];
      }

      try {
        // Refresh the current workflow identity before querying its terminal
        // event, rather than relying only on the identity read before streaming.
        const initialState = await sendStatusIfChanged();

        if (!initialState) {
          send("stream_error", {
            message: "Incident no longer exists.",
          });
          return;
        }

        if (!ACTIVE_WORKFLOW_STATUSES.has(initialState.status)) {
          inactiveSince = Date.now();
        }

        // Replay historical events in sequence order.
        const existing = await db.event.findMany({
          where: {
            incidentId,
            OR: [
              { streamSequence: { gt: lastSeenSequence } },
              ...currentRunFinishedFilter(),
            ],
          },
          orderBy: [{ streamSequence: "asc" }, { id: "asc" }],
        });

        for (const event of existing) {
          // A terminal event at or before Last-Event-ID still matters for
          // completion detection, but must not be replayed with an older ID.
          if (
            typeof event.streamSequence === "number" &&
            event.streamSequence <= lastSeenSequence
          ) {
            continue;
          }

          if (closed) break;

          send(
            null,
            event,
            typeof event.streamSequence === "number"
              ? event.streamSequence
              : undefined,
          );

          seenEventIds.add(event.id);

          if (
            typeof event.streamSequence === "number" &&
            event.streamSequence > lastSeenSequence
          ) {
            lastSeenSequence = event.streamSequence;
          }
        }

        const workflowAlreadyFinished = existing.some((event) =>
          isCurrentWorkflowFinished(
            event,
            incidentId,
            currentWorkflowRunId,
          ),
        );

        if (workflowAlreadyFinished) {
          send("done", {});
          return;
        }

        while (!closed) {
          if (Date.now() - startedAt > MAX_STREAM_MS) {
            // Let EventSource reconnect with its last delivered sequence.
            break;
          }

          await new Promise<void>((resolve) =>
            setTimeout(resolve, POLL_INTERVAL_MS),
          );

          if (closed) break;

          if (!(await stillAuthorized())) {
            send("stream_error", {
              message: "Stream access is no longer authorized.",
            });
            break;
          }

          // Refresh workflow ownership before checking for completion.
          const currentState = await sendStatusIfChanged();

          if (!currentState) {
            send("stream_error", {
              message: "Incident no longer exists.",
            });
            break;
          }

          // Query new events by strict sequence order. Always include the
          // current run's terminal event to handle reconnect and replay races.
          const newEvents = await db.event.findMany({
            where: {
              incidentId,
              OR: [
                { streamSequence: { gt: lastSeenSequence } },
                ...currentRunFinishedFilter(),
              ],
            },
            orderBy: [{ streamSequence: "asc" }, { id: "asc" }],
          });

          let sawWorkflowFinished = false;

          for (const event of newEvents) {
            // Detect completion before skipping an event that has already
            // been delivered or whose sequence is at/below the resume cursor.
            if (
              isCurrentWorkflowFinished(
                event,
                incidentId,
                currentWorkflowRunId,
              )
            ) {
              sawWorkflowFinished = true;
            }

            if (
              typeof event.streamSequence === "number" &&
              event.streamSequence <= lastSeenSequence
            ) {
              continue;
            }

            if (seenEventIds.has(event.id)) continue;

            if (closed) break;

            seenEventIds.add(event.id);

            send(
              null,
              event,
              typeof event.streamSequence === "number"
                ? event.streamSequence
                : undefined,
            );

            if (
              typeof event.streamSequence === "number" &&
              event.streamSequence > lastSeenSequence
            ) {
              lastSeenSequence = event.streamSequence;
            }
          }

          if (closed) break;

          // Completion takes priority over the idle timeout.
          if (sawWorkflowFinished) {
            send("done", {});
            break;
          }

          // Keep a stream open while a workflow is actively investigating,
          // waiting for approval, or executing. The workflow failure handler
          // must recover exhausted active runs in a separate change.
          if (ACTIVE_WORKFLOW_STATUSES.has(currentState.status)) {
            inactiveSince = null;
            continue;
          }

          // An inactive incident with no current-run terminal event should
          // not cause every open tab to poll indefinitely.
          inactiveSince ??= Date.now();

          if (Date.now() - inactiveSince >= INACTIVE_STREAM_GRACE_MS) {
            send("stream_idle", {
              reason: "workflow_inactive",
              status: currentState.status,
              workflowRunId: currentState.workflowRunId,
            });
            break;
          }
        }
      } catch (err) {
        if (!closed) {
          console.error("[incident-stream] Polling loop failed:", err);

          // Avoid using "error", which EventSource reserves for transport errors.
          send("stream_error", {
            message: "Stream interrupted.",
          });
        }
      } finally {
        req.signal.removeEventListener("abort", onRequestAbort);

        if (!closed) {
          controller.close();
        }
      }
    },

    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}