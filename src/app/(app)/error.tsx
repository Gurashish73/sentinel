"use client";

import { useRouter } from "next/navigation";
import { startTransition } from "react";

export default function AppError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
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
          Runtime Exception
        </p>
        <p>Something went wrong while loading this module.</p>
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
