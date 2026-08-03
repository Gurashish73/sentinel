"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Event as IncidentEvent, IncidentStatus } from "@prisma/client";

type StreamState = {
  events: IncidentEvent[];
  status: IncidentStatus;
  isDone: boolean;
  isErrored: boolean;
};

const IncidentStreamContext = createContext<StreamState | null>(null);

export function useIncidentStreamContext(): StreamState {
  const ctx = useContext(IncidentStreamContext);
  if (!ctx) {
    throw new Error("useIncidentStreamContext must be used within an IncidentStreamProvider");
  }
  return ctx;
}

export function IncidentStreamProvider({
  incidentId,
  initialEvents,
  initialStatus,
  children,
}: {
  incidentId: string;
  initialEvents: IncidentEvent[];
  initialStatus: IncidentStatus;
  children: ReactNode;
}) {
  // We hydrate with the server-rendered events/status first, so there is ZERO 
  // flash of empty content while the SSE connection is negotiating.
  const [events, setEvents] = useState<IncidentEvent[]>(initialEvents);
  const [status, setStatus] = useState<IncidentStatus>(initialStatus);
  const [isDone, setIsDone] = useState(false);
  const [isErrored, setIsErrored] = useState(false);

  useEffect(() => {
    const source = new EventSource(`/api/incidents/${incidentId}/stream`);

    source.onmessage = (message) => {
      const event: IncidentEvent = JSON.parse(message.data);
      
      // The route replays everything on connect to catch race conditions — 
      // dedupe by ID so a client that already has the server-rendered initial 
      // list doesn't double up events on the screen.
      setEvents((prev) => (prev.some((e) => e.id === event.id) ? prev : [...prev, event]));
    };

    // Status truth comes from the server (which reads the DB), not from
    // guessing at client-side event-type inference.
    source.addEventListener("status", (message) => {
      const { status } = JSON.parse((message as MessageEvent).data);
      setStatus(status);
    });

    source.addEventListener("done", () => {
      setIsDone(true);
      source.close();
    });

    // Application-level errors from the route handler's catch block — a
    // named event, not the browser's reserved "error", so it can't be
    // confused with a transport disconnect.
    source.addEventListener("stream_error", () => {
      setIsErrored(true);
      setIsDone(true);
    });

    // Transport-level only now — network drops, the connection closing
    // unexpectedly. Application errors have their own event above.
    source.addEventListener("error", () => {
      if (source.readyState === EventSource.CLOSED) {
        setIsDone(true);
        setIsErrored(true);
      }
    });

    return () => source.close();
  }, [incidentId]);

  return (
    <IncidentStreamContext.Provider value={{ events, status, isDone, isErrored }}>
      {children}
    </IncidentStreamContext.Provider>
  );
}