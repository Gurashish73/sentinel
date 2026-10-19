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
    select: { id: true },
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
      let lastSeenSequence = 0;

      // Defensive deduplication in case an event is returned more than once.
      const seenEventIds = new Set<string>();
      let lastSentStatus: string | null = null;

      function send(event: string | null, data: unknown) {
        const prefix = event ? `event: ${event}\n` : "";
        controller.enqueue(
          encoder.encode(`${prefix}data: ${JSON.stringify(data)}\n\n`),
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
          select: { status: true },
        });

        if (!current) return null;

        if (current.status !== lastSentStatus) {
          lastSentStatus = current.status;
          send("status", { status: current.status });
        }

        return current.status;
      }

      try {
        // Replay historical events in sequence order.
        const existing = await db.event.findMany({
          where: { incidentId },
          orderBy: [
            { streamSequence: "asc" },
            { id: "asc" },
          ],
        });

        for (const event of existing) {
          send(null, event);
          seenEventIds.add(event.id);

          if (
            typeof event.streamSequence === "number" &&
            event.streamSequence > lastSeenSequence
          ) {
            lastSeenSequence = event.streamSequence;
          }
        }

        await sendStatusIfChanged();

        while (!closed) {
          if (Date.now() - startedAt > MAX_STREAM_MS) {
            send("done", {});
            break;
          }

          await new Promise((resolve) =>
            setTimeout(resolve, POLL_INTERVAL_MS),
          );

          if (closed) break;

          if (!(await stillAuthorized())) {
            send("done", {});
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
            orderBy: [
              { streamSequence: "asc" },
              { id: "asc" },
            ],
          });

          let sawWorkflowFinished = false;

          for (const event of newEvents) {
            if (seenEventIds.has(event.id)) continue;

            seenEventIds.add(event.id);
            send(null, event);

            if (
              typeof event.streamSequence === "number" &&
              event.streamSequence > lastSeenSequence
            ) {
              lastSeenSequence = event.streamSequence;
            }

            if (event.type === "workflow_finished") {
              sawWorkflowFinished = true;
            }
          }

          const status = await sendStatusIfChanged();

          if (sawWorkflowFinished || status === null) {
            send("done", {});
            break;
          }
        }
      } catch (err) {
        console.error("[incident-stream] Polling loop failed:", err);

        // Avoid using "error", which EventSource reserves for transport errors.
        send("stream_error", { message: "Stream interrupted." });
        send("done", {});
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
