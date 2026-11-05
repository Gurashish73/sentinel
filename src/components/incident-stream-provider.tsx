
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Event as IncidentEvent, IncidentStatus } from "@prisma/client";

type StreamState = {
  events: IncidentEvent[];
  status: IncidentStatus;
  workflowRunId: string | null;
  isDone: boolean;
  isErrored: boolean;
  restartStream: () => void;
};

const IncidentStreamContext = createContext<StreamState | null>(null);

export function useIncidentStreamContext(): StreamState {
  const ctx = useContext(IncidentStreamContext);

  if (!ctx) {
    throw new Error(
      "useIncidentStreamContext must be used within an IncidentStreamProvider",
    );
  }

  return ctx;
}

export function IncidentStreamProvider({
  incidentId,
  initialEvents,
  initialStatus,
  initialWorkflowRunId = null,
  children,
}: {
  incidentId: string;
  initialEvents: IncidentEvent[];
  initialStatus: IncidentStatus;
  initialWorkflowRunId?: string | null;
  children: ReactNode;
}) {
  const [events, setEvents] = useState<IncidentEvent[]>(initialEvents);
  const [status, setStatus] = useState<IncidentStatus>(initialStatus);
  const [workflowRunId, setWorkflowRunId] = useState<string | null>(
    initialWorkflowRunId,
  );
  const [isDone, setIsDone] = useState(false);
  const [isErrored, setIsErrored] = useState(false);
  const [streamGeneration, setStreamGeneration] = useState(0);

  const restartStream = useCallback(() => {
    setIsDone(false);
    setIsErrored(false);
    setStreamGeneration((current) => current + 1);
  }, []);

  useEffect(() => {
    let source: EventSource | null = null;
    let disposed = false;
    let workflowFinished = false;
    let stoppedUntilVisibilityChange = false;
    let pausedForVisibility = document.visibilityState !== "visible";

    function closeSource(expected?: EventSource) {
      if (!source || (expected && source !== expected)) {
        return;
      }

      const current = source;
      source = null;
      current.close();
    }

    function connect() {
      if (
        disposed ||
        source ||
        workflowFinished ||
        pausedForVisibility ||
        stoppedUntilVisibilityChange
      ) {
        return;
      }

      setIsDone(false);
      setIsErrored(false);

      const currentSource = new EventSource(
        `/api/incidents/${incidentId}/stream`,
      );

      source = currentSource;

      currentSource.onmessage = (message) => {
        if (source !== currentSource) return;

        let event: IncidentEvent;

        try {
          event = JSON.parse(message.data) as IncidentEvent;
        } catch {
          setIsErrored(true);
          return;
        }

        // Replay and initial hydration can contain the same event.
        setEvents((previous) =>
          previous.some((item) => item.id === event.id)
            ? previous
            : [...previous, event],
        );
      };

      // Status and current workflow ownership come from the server.
      currentSource.addEventListener("status", (message) => {
        if (source !== currentSource) return;

        try {
          const payload = JSON.parse(
            (message as MessageEvent).data,
          ) as {
            status?: unknown;
            workflowRunId?: unknown;
          };

          if (typeof payload.status === "string") {
            setStatus(payload.status as IncidentStatus);
          }

          if (
            typeof payload.workflowRunId === "string" ||
            payload.workflowRunId === null
          ) {
            setWorkflowRunId(payload.workflowRunId);
          }
        } catch {
          setIsErrored(true);
        }
      });

      // The current workflow has emitted its terminal event.
      currentSource.addEventListener("done", () => {
        if (source !== currentSource) return;

        workflowFinished = true;
        stoppedUntilVisibilityChange = true;
        setIsDone(true);
        setIsErrored(false);
        closeSource(currentSource);
      });

      // Inactivity is not the same as successful workflow completion.
      currentSource.addEventListener("stream_idle", () => {
        if (source !== currentSource) return;

        stoppedUntilVisibilityChange = true;
        setIsDone(false);
        setIsErrored(false);
        closeSource(currentSource);
      });

      // Application-level stream error.
      currentSource.addEventListener("stream_error", () => {
        if (source !== currentSource) return;

        stoppedUntilVisibilityChange = true;
        setIsErrored(true);
        setIsDone(true);
        closeSource(currentSource);
      });

      // Let EventSource handle transient reconnects. Stop if the connection
      // has permanently closed; visibility changes or manual restart can recover.
      currentSource.addEventListener("error", () => {
        if (
          source !== currentSource ||
          currentSource.readyState !== EventSource.CLOSED
        ) {
          return;
        }

        stoppedUntilVisibilityChange = true;
        setIsDone(true);
        setIsErrored(true);
        closeSource(currentSource);
      });
    }

    function handleVisibilityChange() {
      if (disposed) return;

      // Pause immediately while the page is hidden. Do not reconnect here.
      if (document.visibilityState !== "visible") {
        pausedForVisibility = true;
        closeSource();
        return;
      }

      // Resume only after a genuine return from a hidden state.
      if (!pausedForVisibility) return;

      pausedForVisibility = false;

      // A completed workflow must not restart on visibility changes.
      if (workflowFinished) return;

      // Reconnect after hidden-tab pauses, idle termination, or recoverable
      // stream errors. connect() still enforces all lifecycle guards.
      stoppedUntilVisibilityChange = false;
      setIsDone(false);
      setIsErrored(false);
      connect();
    }

    document.addEventListener(
      "visibilitychange",
      handleVisibilityChange,
    );

    if (!pausedForVisibility) {
      connect();
    }

    return () => {
      disposed = true;

      document.removeEventListener(
        "visibilitychange",
        handleVisibilityChange,
      );

      closeSource();
    };
  }, [incidentId, streamGeneration]);

  return (
    <IncidentStreamContext.Provider
      value={{
        events,
        status,
        workflowRunId,
        isDone,
        isErrored,
        restartStream,
      }}
    >
      {children}
    </IncidentStreamContext.Provider>
  );
}
