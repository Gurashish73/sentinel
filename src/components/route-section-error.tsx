"use client";

import { useRouter } from "next/navigation";
import { startTransition } from "react";

type RouteSectionErrorProps = {
  section: string;
  reset: () => void;
};

export function RouteSectionError({
  section,
  reset,
}: RouteSectionErrorProps) {
  const router = useRouter();

  function handleRetry() {
    startTransition(() => {
      router.refresh();
      reset();
    });
  }

  return (
    <main className="flex min-h-[50vh] flex-col items-center justify-center gap-6 bg-zinc-950 px-6 text-center">
      <div className="space-y-2 text-sm text-zinc-200">
        <p className="font-mono text-xs uppercase tracking-widest text-red-400">
          Section unavailable
        </p>
        <p>{section} could not be loaded.</p>
        <p className="text-xs text-zinc-500">
          Try again to recover this section.
        </p>
      </div>

      <button
        type="button"
        onClick={handleRetry}
        className="rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
      >
        Try again
      </button>
    </main>
  );
}
