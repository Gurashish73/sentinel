
"use client";

import { startTransition } from "react";

export default function AppError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-[50vh] flex-col items-center justify-center gap-6 px-6 text-center bg-zinc-950">
      <div className="space-y-2 text-zinc-200 text-sm">
        <p className="text-red-400 font-mono uppercase tracking-widest text-xs">
          Runtime Exception
        </p>
        <p>Something went wrong while loading this module.</p>
      </div>

      <button
        onClick={() => startTransition(() => reset())}
        className="rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
      >
        Try again
      </button>
    </main>
  );
}
