"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { createRunbook, type RunbookState } from "@/actions/runbooks";

/**
 * CREATE RUNBOOK FORM (Client Component)
 * 
 * A React 19 progressively enhanced form. It wires directly into our 
 * `createRunbook` Server Action, eliminating boilerplate state management.
 * Zod validation errors and success messages are passed seamlessly back 
 * from the server and rendered locally.
 */

const initialState: RunbookState = {};

// Must be extracted into its own component so `useFormStatus` 
// can hook into the parent <form> rendering context.
function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-zinc-300 disabled:opacity-50 transition-colors"
    >
      {pending ? "Saving…" : "Save runbook"}
    </button>
  );
}

export function CreateRunbookForm({ orgId }: { orgId: string }) {
  const [state, formAction] = useActionState(createRunbook, initialState);

  return (
    <form action={formAction} className="space-y-3 rounded-md border border-zinc-800 p-4 bg-zinc-900/30">
      {/* Target the mutation to the correct tenant */}
      <input type="hidden" name="orgId" value={orgId} />

      <div>
        <label className="text-xs font-mono uppercase tracking-wider text-zinc-400">Title</label>
        <input
          name="title"
          required
          className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-500"
        />
        {state.errors?.title && (
          <p className="mt-1 text-xs text-red-400 font-mono">{state.errors.title[0]}</p>
        )}
      </div>

      <div>
        <label className="text-xs font-mono uppercase tracking-wider text-zinc-400">Content</label>
        <textarea
          name="content"
          required
          rows={6}
          placeholder="Steps, known causes, escalation contacts…"
          className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-500"
        />
        {state.errors?.content && (
          <p className="mt-1 text-xs text-red-400 font-mono">{state.errors.content[0]}</p>
        )}
      </div>

      <SubmitButton />
      
      {state.message && (
        <p className="text-xs text-emerald-400 font-mono">{state.message}</p>
      )}
    </form>
  );
}