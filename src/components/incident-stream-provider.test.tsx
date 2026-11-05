
/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  IncidentStreamProvider,
  useIncidentStreamContext,
} from "./incident-stream-provider";

class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  static instances: MockEventSource[] = [];

  readonly url: string;
  readyState = MockEventSource.CONNECTING;
  closed = false;

  onmessage: ((event: MessageEvent) => void) | null = null;

  private listeners = new Map<
    string,
    Set<(event: MessageEvent) => void>
  >();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) {
    const callback =
      typeof listener === "function"
        ? (event: MessageEvent) => listener(event)
        : (event: MessageEvent) => listener.handleEvent(event);

    const callbacks = this.listeners.get(type) ?? new Set();
    callbacks.add(callback);
    this.listeners.set(type, callbacks);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) {
    const callbacks = this.listeners.get(type);
    if (!callbacks) return;

    for (const callback of callbacks) {
      // Listener removal is not required by the provider, but is implemented
      // for completeness of this small EventSource test double.
      if (
        callback === listener ||
        callback.toString() === listener.toString()
      ) {
        callbacks.delete(callback);
      }
    }
  }

  close() {
    this.closed = true;
    this.readyState = MockEventSource.CLOSED;
  }

  emit(type: string, data = "{}") {
    const event = new MessageEvent(type, { data });

    for (const callback of this.listeners.get(type) ?? []) {
      callback(event);
    }
  }
}

function StreamProbe() {
  const stream = useIncidentStreamContext();

  return (
    <div>
      <span data-testid="status">{stream.status}</span>
      <span data-testid="done">{String(stream.isDone)}</span>
      <span data-testid="errored">{String(stream.isErrored)}</span>
    </div>
  );
}

function renderProvider() {
  return render(
    <IncidentStreamProvider
      incidentId="incident-1"
      initialEvents={[]}
      initialStatus="OPEN"
      initialWorkflowRunId="workflow-1"
    >
      <StreamProbe />
    </IncidentStreamProvider>,
  );
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });

  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  cleanup();
  MockEventSource.instances = [];

  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });

  vi.stubGlobal(
    "EventSource",
    MockEventSource as unknown as typeof EventSource,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("IncidentStreamProvider visibility lifecycle", () => {
  it("closes the connection when the tab becomes hidden without reconnecting", () => {
    renderProvider();

    expect(MockEventSource.instances).toHaveLength(1);

    const original = MockEventSource.instances[0];

    setVisibility("hidden");

    expect(original.closed).toBe(true);
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it("reconnects when a paused tab becomes visible again", () => {
    renderProvider();

    const original = MockEventSource.instances[0];

    setVisibility("hidden");

    expect(original.closed).toBe(true);

    setVisibility("visible");

    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1].url).toBe(
      "/api/incidents/incident-1/stream",
    );
  });

  it("does not connect initially while the tab is hidden", () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });

    renderProvider();

    expect(MockEventSource.instances).toHaveLength(0);

    setVisibility("visible");

    expect(MockEventSource.instances).toHaveLength(1);
  });

  it("does not reconnect after the current workflow has finished", () => {
    renderProvider();

    const original = MockEventSource.instances[0];

    act(() => {
      original.emit("done");
    });

    expect(original.closed).toBe(true);

    setVisibility("hidden");
    setVisibility("visible");

    expect(MockEventSource.instances).toHaveLength(1);
  });

  it("resumes an idle stream after a hidden-to-visible transition", () => {
    renderProvider();

    const original = MockEventSource.instances[0];

    act(() => {
      original.emit("stream_idle");
    });

    expect(original.closed).toBe(true);

    setVisibility("hidden");
    setVisibility("visible");

    expect(MockEventSource.instances).toHaveLength(2);
  });
});
