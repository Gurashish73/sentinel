"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { createOrgAndBecomeCommander, type CreateOrgState } from "@/actions/onboarding";

/**
 * CREATE ORGANIZATION FORM (Client Component)
 * 
 * The gateway form for new users to provision a workspace. 
 * It uses native HTML pattern validation for instant client-side feedback 
 * on the slug, backed by strict Zod validation on the server.
 */

const initialState: CreateOrgState = {};

// Isolated to safely consume the pending state of the parent <form>
function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-zinc-300 disabled:opacity-50 transition-colors"
    >
      {pending ? "Creating…" : "Create organization"}
    </button>
  );
}

export function CreateOrgForm() {
  const [state, formAction] = useActionState(createOrgAndBecomeCommander, initialState);

  return (
    <form action={formAction} className="w-full max-w-sm space-y-4 rounded-md border border-zinc-800 p-6 bg-zinc-900/30">
      <div>
        <label className="text-xs font-mono uppercase tracking-wider text-zinc-400">
          Organization name
        </label>
        <input
          name="name"
          required
          placeholder="Sentinel HQ"
          className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-500"
        />
        {state.errors?.name && (
          <p className="mt-1 text-xs text-red-400 font-mono">{state.errors.name[0]}</p>
        )}
      </div>

      <div>
        <label className="text-xs font-mono uppercase tracking-wider text-zinc-400">
          Slug
        </label>
        <input
          name="slug"
          required
          placeholder="sentinel-hq"
          // Native browser validation acts as the first line of defense
          pattern="[a-z0-9-]+"
          title="Lowercase letters, numbers, and hyphens only."
          className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-500"
        />
        {state.errors?.slug && (
          <p className="mt-1 text-xs text-red-400 font-mono">{state.errors.slug[0]}</p>
        )}
      </div>

      <SubmitButton />
    </form>
  );
}