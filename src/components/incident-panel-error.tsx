"use client";

import { startTransition } from "react";

type IncidentPanelErrorProps = {
  panel: string;
  reset: () => void;
};

export function IncidentPanelError({
  panel,
  reset,
}: IncidentPanelErrorProps) {
  return (
    <section
      role="alert"
      className="rounded-md border border-red-900/60 bg-zinc-950 p-4"
    >
      <p className="font-mono text-xs uppercase tracking-wider text-red-400">
        Panel unavailable
      </p>

      <p className="mt-2 text-sm text-zinc-200">
        {panel} could not be loaded.
      </p>

      <p className="mt-1 text-xs text-zinc-500">
        The rest of the incident view may still be available.
        You can retry loading this panel.
      </p>

      <button
        type="button"
        onClick={() => startTransition(() => reset())}
        className="mt-4 rounded-md border border-zinc-700 px-3 py-2 text-xs text-zinc-300 transition hover:bg-zinc-800"
      >
        Try again
      </button>
    </section>
  );
}
