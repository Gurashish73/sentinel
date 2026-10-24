import "server-only";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import type { NextRequest } from "next/server";

// Force Node.js runtime. Prisma's pg driver does not support Edge environments.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hard ceiling on connection duration to prevent forgotten tabs from
// indefinitely draining serverless DB connections.
export const maxDuration = 300;

const POLL_INTERVAL_MS = 1500;
const MAX_STREAM_MS = 280_000; // Stay under maxDuration with margin

function parseLastEventId(value: string | null): number {
  if (value === null || !/^\d+$/.test(value)) return 0;

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function isCurrentWorkflowFinished(
  event: { type: string; payload: unknown; externalId?: string | null },
  incidentId: string,
  workflowRunId: string | null,
): boolean {
  if (event.type !== "workflow_finished" || !workflowRunId) return false;

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

  req.signal.addEventListener("abort", () => {
    closed = true;
  });

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
      let workflowAlreadyFinished = false;
      let lastSentStatus: string | null = null;

      function send(event: string | null, data: unknown, id?: number) {
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
        const membership = await db.membership.findUnique({
          where: { userId_orgId: { userId, orgId } },
        });

        return !!membership;
      }

      async function sendStatusIfChanged() {
        // Keep this read scoped to both incident and organization.
        const current = await db.incident.findFirst({
          where: { id: incidentId, orgId },
          select: { status: true, workflowRunId: true },
        });

        if (!current) return null;

        currentWorkflowRunId = current.workflowRunId;

        if (current.status !== lastSentStatus) {
          lastSentStatus = current.status;
          send("status", { status: current.status });
        }

        return current.status;
      }

      try {
        // Replay historical events in sequence order.
        const existing = await db.event.findMany({
          where: {
            incidentId,
            OR: [
              { streamSequence: { gt: lastSeenSequence } },
              ...(currentWorkflowRunId
                ? [
                    {
                      type: "workflow_finished",
                      externalId: {
                        startsWith: `sentinel-agent-event:${incidentId}:workflow:${currentWorkflowRunId}:workflow:finished:`,
                      },
                    },
                  ]
                : []),
            ],
          },
          orderBy: [{ streamSequence: "asc" }, { id: "asc" }],
        });

        for (const event of existing) {
          // A terminal event at or before Last-Event-ID still matters, but must
          // not be replayed with an older SSE id.
          if (
            typeof event.streamSequence === "number" &&
            event.streamSequence <= lastSeenSequence
          ) {
            continue;
          }

          send(
            null,
            event,
            typeof event.streamSequence === "number"
              ? event.streamSequence
              : undefined,
          );
          seenEventIds.add(event.id);

          // Keep the replay cursor aligned with the last event sent so the
          // first poll only asks for events that arrived after this replay.
          if (
            typeof event.streamSequence === "number" &&
            event.streamSequence > lastSeenSequence
          ) {
            lastSeenSequence = event.streamSequence;
          }
        }

        await sendStatusIfChanged();

        workflowAlreadyFinished = existing.some((event) =>
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
            // Close cleanly so EventSource reconnects with its last delivered sequence.
            break;
          }

          await new Promise((resolve) =>
            setTimeout(resolve, POLL_INTERVAL_MS),
          );

          if (closed) break;

          if (!(await stillAuthorized())) {
            send("stream_error", {
              message: "Stream access is no longer authorized.",
            });
            break;
          }

          // Refresh ownership before deciding whether a terminal event belongs
          // to the currently active workflow run.
          const status = await sendStatusIfChanged();

          if (status === null) {
            send("stream_error", {
              message: "Incident no longer exists.",
            });
            break;
          }

          // Use a strict sequence cursor rather than createdAt.
          // The database trigger serializes sequence allocation until commit,
          // preventing late commits from falling behind the cursor.
          const newEvents = await db.event.findMany({
            where: {
              incidentId,
              streamSequence: { gt: lastSeenSequence },
            },
            orderBy: [{ streamSequence: "asc" }, { id: "asc" }],
          });

          let sawWorkflowFinished = false;

          for (const event of newEvents) {
            if (seenEventIds.has(event.id)) continue;

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

            if (
              isCurrentWorkflowFinished(
                event,
                incidentId,
                currentWorkflowRunId,
              )
            ) {
              sawWorkflowFinished = true;
            }
          }

          if (sawWorkflowFinished) {
            send("done", {});
            break;
          }
        }
      } catch (err) {
        console.error("[incident-stream] Polling loop failed:", err);

        // Avoid using "error", which EventSource reserves for transport errors.
        send("stream_error", { message: "Stream interrupted." });
      } finally {
        controller.close();
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