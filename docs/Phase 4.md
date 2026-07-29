# Phase 4: Real-Time Dashboard & Live Agent Updates

## Overview

Phase 4 transforms Sentinel from a refresh-driven application into a real-time operational dashboard. The primary goal is to eliminate the temporary UI compromises introduced in Phase 3 by streaming agent events directly to connected clients, allowing incident timelines and workflow state to update automatically without manual refreshes.

Rather than polling entire pages or relying on optimistic assumptions, the UI becomes event-driven. Agent reasoning, tool calls, approvals, rejections, and execution events appear live as the workflow progresses.

---

## Developer Notes & Architecture Decisions

### Lightweight Server-Sent Events (SSE)

Instead of introducing Redis Pub/Sub or WebSockets, Sentinel uses a lightweight Server-Sent Events endpoint backed by database polling.

Each connected client receives:

- complete existing timeline immediately
- only newly-created events afterwards
- automatic disconnect once investigation finishes

This keeps deployment completely serverless while still providing near real-time updates.

---

### Replay Before Streaming

New clients always receive the complete existing event history before entering the polling loop.

Without this replay, refreshing an incident page during an active investigation would temporarily hide earlier reasoning until another workflow event occurred.

---

### Database Reads over Cached Queries

Unlike dashboard pages, the streaming endpoint deliberately bypasses the cache layer.

The entire purpose of the endpoint is detecting new database writes. Using cached queries would defeat that goal.

---

### React Optimistic UI

Phase 3 temporarily hid the Approve / Reject buttons using local component state.

Phase 4 replaces that workaround with React's `useOptimistic()`, allowing approvals to feel instantaneous while naturally reconciling once streamed server state arrives.

---

### Parallel Routes

The incident detail page now uses Parallel Routes.

Instead of blocking the entire page while agent reasoning loads:

- incident metadata renders immediately
- reasoning timeline streams independently
- loading boundaries become isolated

This demonstrates the intended architectural use of Parallel Routes rather than using them only as a routing exercise.

---

### Intercepting Routes

Opening an incident from the dashboard displays the detail page inside a modal using Intercepting Routes.

Direct navigation continues rendering the standalone page, allowing both navigation patterns to share the same implementation.

---

### Streaming Authorization

Long-lived streaming connections perform the same organization membership and role verification used throughout Sentinel.

Authorization is never skipped simply because the connection remains open.

---

## Implementation Checklist

### 1. Streaming Endpoint

Create:

```text
src/app/api/incidents/[id]/stream/route.ts
```

Responsibilities:

- authenticate every request
- validate organization membership
- replay existing timeline
- stream new events
- detect disconnects
- close completed investigations

---

### 2. Streaming Hook

Create:

```text
src/hooks/use-incident-stream.ts
```

Responsibilities:

- establish EventSource connection
- merge replayed and streamed events
- automatically reconnect
- prevent duplicate events
- cleanly close connections

---

### 3. Optimistic Approval Controls

Update:

```text
src/components/approval-controls.tsx
```

Replace the temporary Phase 3 local state with:

- `useOptimistic()`
- pending UI
- streamed reconciliation

---

### 4. Timeline Component

Update:

```text
src/components/incident-timeline.tsx
```

Responsibilities:

- render replayed history
- append streamed events
- preserve chronological ordering
- avoid duplicate rendering

---

### 5. Parallel Route Layout

Introduce:

```text
app
└── incidents
    └── [id]
        ├── page.tsx
        ├── @timeline
        ├── @reasoning
        └── layout.tsx
```

Split the incident page into independent rendering boundaries.

---

### 6. Intercepting Route

Introduce:

```text
app
└── @modal
    └── (.)incidents
        └── [id]
```

Allow dashboard navigation to open incident details inside a modal without losing dashboard context.

---

### 7. Dashboard Integration

Update Commander dashboard to:

- open incidents inside modal
- subscribe to live timeline updates
- automatically refresh workflow state
- remove manual refresh requirements

---

## Definition of Done

- [ ] Refreshing an incident during an active investigation immediately displays the complete existing timeline.
- [ ] Agent thoughts stream into the UI automatically.
- [ ] Tool calls appear without refreshing.
- [ ] Proposed actions stream live.
- [ ] Approval and rejection actions reconcile automatically.
- [ ] Incident status updates without manual reloads.
- [ ] Optimistic UI replaces Phase 3's temporary workaround.
- [ ] Parallel Routes isolate rendering boundaries.
- [ ] Intercepting Routes display incidents as dashboard modals.
- [ ] Streaming connections enforce organization membership and RBAC.
- [ ] Closing the browser correctly terminates the stream.
