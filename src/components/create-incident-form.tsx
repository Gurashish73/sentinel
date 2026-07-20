"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { createIncident, type CreateIncidentState } from "@/actions/incidents";

/**
 * CREATE INCIDENT FORM (Client Component)
 * 
 * A React 19 progressively enhanced form. By leveraging `useActionState` 
 * and `useFormStatus`, we eliminate the need for manual `useState` tracking, 
 * `e.preventDefault()`, and custom fetch wrappers. 
 * 
 * Zod validation errors from the Server Action are automatically caught 
 * and rendered next to their respective fields.
 */

const initialState: CreateIncidentState = {};

// Must be a separate component so `useFormStatus` can hook into the parent <form> context.
function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-neutral-100 px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-neutral-300 disabled:opacity-50"
    >
      {pending ? "Creating…" : "Create incident"}
    </button>
  );
}

export function CreateIncidentForm({ orgId }: { orgId: string }) {
  // Wires the frontend directly to the Zod-validated Server Action
  const [state, formAction] = useActionState(createIncident, initialState);

  return (
    <form action={formAction} className="space-y-3 rounded-md border border-neutral-800 p-4">
      {/* 
        Passes the target orgId to the server. The server explicitly verifies 
        the user's membership against this ID before executing the mutation. 
      */}
      <input type="hidden" name="orgId" value={orgId} />

      <div>
        <label className="text-xs font-medium text-neutral-400">Title</label>
        <input
          name="title"
          required
          className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
        />
        {/* Render field-specific Zod errors */}
        {state.errors?.title && <p className="mt-1 text-xs text-red-400">{state.errors.title[0]}</p>}
      </div>

      <div>
        <label className="text-xs font-medium text-neutral-400">Description</label>
        <textarea
          name="description"
          rows={3}
          className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
        />
      </div>

      <div>
        <label className="text-xs font-medium text-neutral-400">Severity</label>
        <select
          name="severity"
          defaultValue="MEDIUM"
          className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
        >
          <option value="LOW">Low</option>
          <option value="MEDIUM">Medium</option>
          <option value="HIGH">High</option>
          <option value="CRITICAL">Critical</option>
        </select>
      </div>

      <SubmitButton />
      
      {/* Render success or generic error messages */}
      {state.message && <p className="text-xs text-neutral-400">{state.message}</p>}
    </form>
  );
}