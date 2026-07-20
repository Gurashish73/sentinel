"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { updateOrgSettings, type OrgSettingsState } from "@/actions/org";

/**
 * ORGANIZATION SETTINGS FORM (Client Component)
 * 
 * A progressively enhanced React 19 form restricted to the COMMANDER role.
 * It interfaces directly with our cryptographic data access layer to allow 
 * safe, partial updates of organization metadata and webhook secrets.
 */

const initialState: OrgSettingsState = {};

// Extracted to safely consume the parent <form> pending state via React Context
function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-zinc-300 disabled:opacity-50 transition-colors"
    >
      {pending ? "Saving…" : "Save settings"}
    </button>
  );
}

export function OrgSettingsForm({ 
  orgId, 
  currentName 
}: { 
  orgId: string; 
  currentName: string;
}) {
  // Wires the UI to the Zod-validated updateOrgSettings Server Action
  const [state, formAction] = useActionState(updateOrgSettings, initialState);

  return (
    <form action={formAction} className="space-y-4 rounded-md border border-zinc-800 p-6 bg-zinc-900/30">
      <input type="hidden" name="orgId" value={orgId} />

      <div>
        <label className="text-xs font-mono uppercase tracking-wider text-zinc-400">
          Organization name
        </label>
        <input
          name="name"
          defaultValue={currentName}
          required
          className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-500"
        />
        {state.errors?.name && (
          <p className="mt-1 text-xs text-red-400 font-mono">{state.errors.name[0]}</p>
        )}
      </div>

      <div>
        <label className="text-xs font-mono uppercase tracking-wider text-zinc-400">
          Webhook secret (leave blank to keep the current one)
        </label>
        <input
          name="webhookSecret"
          type="password"
          placeholder="••••••••••••••••"
          className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-500"
        />
        <p className="mt-1 text-xs text-zinc-600">
          This is what Phase 2&apos;s webhook route will verify inbound alert signatures against. Stored encrypted.
        </p>
        {state.errors?.webhookSecret && (
          <p className="mt-1 text-xs text-red-400 font-mono">{state.errors.webhookSecret[0]}</p>
        )}
      </div>

      <SubmitButton />
      
      {state.message && (
        <p className="text-xs text-emerald-400 font-mono">{state.message}</p>
      )}
    </form>
  );
}