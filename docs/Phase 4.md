# Phase 4: Real-Time Dashboard & Live Agent Updates

## Overview

Phase 4 bridges the gap between Sentinel's asynchronous AI workflows (Phase 3) and the humans operating them.

The agent may spend several seconds triaging an alert, diagnosing the root cause, reasoning about a remediation, and waiting for a Commander to approve or reject the proposed action. Requiring users to manually refresh the page during this process creates poor operational UX.

Instead, Phase 4 introduces a real-time event pipeline using Server-Sent Events (SSE). As the background workflow writes execution events into the database, connected clients receive those updates automatically, allowing the incident timeline and workflow state to evolve live without page refreshes.

---

## Developer Notes & Architecture Decisions

### 1. Incident Stream Provider

Instead of allowing every component to establish its own streaming connection, Phase 4 introduces a shared `IncidentStreamProvider`.

```
src/components/incident-stream-provider.tsx
```

The provider:

- opens exactly one EventSource connection per incident page
- hydrates with server-rendered events and status to avoid UI flashing
- exposes a shared React Context consumed by both timeline panels
- deduplicates replayed events by event ID
- keeps workflow status synchronized directly from the server

This prevents duplicate SSE connections while ensuring every component observes the same source of truth.

---

### 2. Polling-Backed Server-Sent Events (SSE)

Sentinel deliberately uses Server-Sent Events instead of WebSockets.

The application only requires one-way communication from the server to the browser, making SSE a better fit for a serverless architecture without introducing additional infrastructure.

Unlike a Redis Pub/Sub architecture, the endpoint is intentionally backed by lightweight database polling.

The polling approach is intentional rather than a shortcut. The workflow route and the SSE connection execute as independent serverless invocations and cannot share in-memory state. Polling keeps the architecture infrastructure-light while remaining reliable for Sentinel's workload.

```
src/app/api/incidents/[id]/stream/route.ts
```

Every 1.5 seconds the stream:

- verifies authorization
- checks for newly written events
- emits updated workflow status
- forwards new database rows to connected clients

The browser experiences a continuous live stream while the implementation remains infrastructure-light and fully serverless.

---

### 3. Replay Before Streaming

New clients always receive the complete event history before entering the polling loop.

Immediately after connecting, the SSE endpoint replays every historical event for the incident before streaming new ones.

The provider deduplicates these replayed events against its server-rendered initial state, ensuring reconnects never produce duplicate timeline entries.

This guarantees:

- no missing reasoning
- no temporary empty timeline
- no race conditions during reconnects

---

### 4. Approval Reconciliation (Why `useOptimistic()` Was Removed)

The original Phase 4 plan proposed React's `useOptimistic()`.

During implementation this approach was intentionally removed.

The server action only submits the Commander's decision to the workflow.

The actual workflow continues executing asynchronously before eventually updating the database.

Using optimistic UI caused the interface to briefly revert back to the previous state before the workflow had actually completed.

Instead, ApprovalControls implements an explicit three-state reconciliation model.

```
src/components/approval-controls.tsx
```

States:

**Interactive**

- Approve / Reject buttons are visible.

**Processing**

- `isAwaitingStream` is enabled immediately after submission.
- Buttons disappear.
- A neutral waiting message is shown while the workflow continues.

**Terminal**

- The waiting state clears only when the live SSE status changes from `AWAITING_APPROVAL`.

No workflow outcome is guessed on the client.

The UI changes only when the server confirms the new state.

---

### 5. Role-Gated Timeline Controls

The incident timeline panel performs UI-level authorization before rendering controls.

```
src/components/incident-timeline-panel.tsx
```

Two distinct permissions are evaluated:

- `canApprove` → Commander only
- `canMutateStatus` → Commander and Engineer

This separates workflow approval from manual incident status transitions.

It also fixes a Phase 3 issue where Engineers could briefly see approval controls that the backend would ultimately reject.

Observers receive an informational waiting message instead of interactive controls.

---

### 6. Dashboard Auto Refresh

Incident detail pages use live SSE.

Dashboard pages intentionally do not.

Instead, dashboards use lightweight conditional polling.

```
src/components/dashboard-auto-refresh.tsx
```

When at least one visible incident is active, the dashboard performs:

- `router.refresh()` every eight seconds

Polling automatically stops once every incident reaches a terminal state.

This keeps dashboards reasonably fresh without maintaining a permanent streaming connection for every open dashboard.

---

### 7. Stream Security & Lifecycle

The SSE endpoint treats authorization as a continuous requirement rather than a one-time check.

Every polling interval revalidates organization membership before sending additional events.

If a user's membership changes while the stream is open, the connection is terminated immediately.

The stream also terminates under the following conditions:

- workflow emits a `workflow_finished` event
- maximum stream lifetime is reached
- browser disconnects
- request is aborted
- incident is removed

This prevents orphaned streaming connections while keeping authorization continuously enforced.

---

### 8. Parallel & Intercepting Routes

Incident pages are divided using Next.js Parallel Routes.

```
(app)/commander/incidents/[id]/
    @timeline/
    @reasoning/
```

The shared layout mounts a single `IncidentStreamProvider`, allowing both route segments to consume the same live workflow state.

### Intercepting Routes
Commander and Engineer dashboards additionally implement Intercepting Routes.

```
(app)/commander/@modal/
(app)/engineer/@modal/
```

These routes allow incidents to open inside dashboard modals without losing dashboard context.

Observer intentionally does not implement intercepting routes, since the role is read-only and does not require modal workflow interactions.

**Architectural Note**

The modal intentionally uses a native HTML `<a>` element instead of Next.js `<Link>` when navigating to the standalone incident page.

Because the intercepted modal and the standalone page share the same pathname, client-side navigation can leave the modal permanently mounted. A hard navigation guarantees the router resolves the standalone route correctly.

---

# Implementation Checklist

### Streaming Infrastructure

```
src/components/incident-stream-provider.tsx
src/app/api/incidents/[id]/stream/route.ts
```

Implemented:

- shared IncidentStreamProvider
- single EventSource connection
- replay before streaming
- polling-backed SSE
- event deduplication
- live status synchronization

---

### Approval Flow

```
src/components/approval-controls.tsx
```

Implemented:

- explicit reconciliation state machine
- server-confirmed workflow transitions
- waiting state between submission and workflow completion
- network failure recovery

---

### Timeline Panel

```
src/components/incident-timeline-panel.tsx
```

Implemented:

- live workflow status
- role-gated controls
- Commander approval flow
- Engineer status controls
- Observer waiting state

---

### Dashboard Refresh

```
src/components/dashboard-auto-refresh.tsx
```

Implemented:

- conditional polling
- automatic refresh every eight seconds
- polling disabled when no active incidents remain

---

### Routing

```
(app)/commander/
(app)/engineer/
(app)/observer/
```

Implemented:

- Parallel Routes
- Intercepting Routes (Commander & Engineer)
- shared provider layout
- role-specific incident experiences

---

## Definition of Done

- [x] Incident timelines stream live without manual refresh.
- [x] Existing event history is replayed before live streaming begins.
- [x] Workflow status updates are synchronized from the server.
- [x] Approval reconciliation uses explicit stream-driven state instead of optimistic UI.
- [x] Timeline controls are gated by role before rendering.
- [x] Dashboard refreshes automatically while active incidents exist.
- [x] SSE authorization is revalidated throughout the connection lifetime.
- [x] Workflow completion cleanly terminates active streams.
- [x] Parallel Routes isolate timeline and reasoning views.
- [x] Commander and Engineer dashboards support Intercepting Route modals.
- [x] Browser disconnects and request aborts cleanly terminate active streams.