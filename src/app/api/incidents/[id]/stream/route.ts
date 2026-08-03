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

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: incidentId } = await params;

  const session = await auth();
  if (!session?.user) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!session.user.activeOrgId) {
    return new Response("No active organization", { status: 403 });
  }
  // Because this const is assigned AFTER the check, TypeScript guarantees 
  // it is a string and safely preserves that type inside the stream closures.
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
      let lastSeenCreatedAt = new Date(0);
      let lastSentStatus: string | null = null;

      function send(event: string | null, data: unknown) {
        const prefix = event ? `event: ${event}\n` : "";
        controller.enqueue(encoder.encode(`${prefix}data: ${JSON.stringify(data)}\n\n`));
      }

      // Re-verify authorization every tick to cut off access immediately 
      // if a user's role is revoked mid-stream.
      async function stillAuthorized(): Promise<boolean> {
        const m = await db.membership.findUnique({ where: { userId_orgId: { userId, orgId } } });
        return !!m;
      }

      async function sendStatusIfChanged() {
        // findFirst, not findUnique: id alone isn't scoped to this org, and
        // there's no compound (id, orgId) unique constraint to findUnique
        // against. Every other incident read in this route is org-scoped —
        // this one was the exception, not a deliberate choice.
        const current = await db.incident.findFirst({ where: { id: incidentId, orgId }, select: { status: true } });
        if (!current) return null;
        if (current.status !== lastSentStatus) {
          lastSentStatus = current.status;
          send("status", { status: current.status });
        }
        return current.status;
      }

      try {
        // Replay historical events instantly to prevent UI flashing on connect.
        const existing = await db.event.findMany({
          where: { incidentId },
          orderBy: { createdAt: "asc" },
        });
        
        for (const event of existing) {
          send(null, event);
          lastSeenCreatedAt = event.createdAt;
        }
        await sendStatusIfChanged();

        while (!closed) {
          if (Date.now() - startedAt > MAX_STREAM_MS) {
            send("done", {});
            break;
          }

          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          if (closed) break;

          if (!(await stillAuthorized())) {
            send("done", {});
            break;
          }

          // Bypass Phase 1's caching layer. Polling requires genuinely 
          // fresh reads to detect database changes.
          const newEvents = await db.event.findMany({
            where: { incidentId, createdAt: { gt: lastSeenCreatedAt } },
            orderBy: { createdAt: "asc" },
          });

          let sawWorkflowFinished = false;
          for (const event of newEvents) {
            send(null, event);
            lastSeenCreatedAt = event.createdAt;
            if (event.type === "workflow_finished") sawWorkflowFinished = true;
          }

          const status = await sendStatusIfChanged();

          if (sawWorkflowFinished || status === null) {
            send("done", {});
            break;
          }
        }
      } catch (err) {
        console.error("[incident-stream] Polling loop failed:", err);
        // "error" is reserved by EventSource for transport-level failures —
        // an application-level error sent under that name is indistinguishable
        // from a dropped connection on the client. stream_error is its own
        // event; done still fires right after so the client always has a
        // clean, unambiguous signal to stop listening.
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
      "X-Accel-Buffering": "no", // Prevent reverse-proxy batching
    },
  });
}