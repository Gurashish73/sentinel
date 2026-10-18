
"use client";

import { useState, useTransition } from "react";
import { reindexRunbook } from "@/actions/runbooks";

type ReindexRunbookButtonProps = {
  runbookId: string;
  orgId: string;
};

export function ReindexRunbookButton({
  runbookId,
  orgId,
}: ReindexRunbookButtonProps) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState<boolean | null>(null);

  function handleReindex() {
    setMessage("");
    setSuccess(null);

    startTransition(async () => {
      try {
        const result = await reindexRunbook(runbookId, orgId);

        setMessage(result.message);
        setSuccess(result.success);
      } catch {
        setMessage("Could not re-index this runbook. Please try again.");
        setSuccess(false);
      }
    });
  }

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={handleReindex}
        disabled={isPending}
        className="rounded border border-zinc-700 px-3 py-2 text-xs font-mono text-zinc-300 transition hover:border-violet-500 hover:text-violet-300 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? "Re-indexing..." : "Re-index"}
      </button>

      {message && (
        <p
          role="status"
          aria-live="polite"
          className={`mt-2 text-xs ${
            success ? "text-emerald-400" : "text-amber-400"
          }`}
        >
          {message}
        </p>
      )}
    </div>
  );
}
