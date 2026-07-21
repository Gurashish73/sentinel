"use client";

import { useTransition, useState } from "react";
import { simulateAlert } from "@/actions/webhooks";

export function SimulateAlertButton({ orgId }: { orgId: string }) {
  const [isPending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ message: string; isError: boolean } | null>(null);

  const handleSimulate = () => {
    // Reset state on new click
    setFeedback(null);
    
    startTransition(async () => {
      const response = await simulateAlert(orgId);
      
      // Handle the safe return signature failure (e.g. RBAC block or DB timeout)
      if (!response.success || !response.data) {
        setFeedback({ 
          message: response.error || "Simulation failed.", 
          isError: true 
        });
        return;
      }

      // TYPE NARROWING: Check the status first to satisfy TypeScript's discriminated union
      if (response.data.status === "created") {
        setFeedback({
          message: `✅ Incident created successfully (ID: ${response.data.incidentId}).`,
          isError: false
        });
        
        // Keep the UI clean by clearing success messages after 5 seconds
        setTimeout(() => setFeedback(null), 5000);
      } else {
        // TypeScript now knows response.data is strictly { status: "duplicate" } here
        setFeedback({
          message: "⚠️ Duplicate delivery — no-op.",
          isError: false
        });
      }
    });
  };

  return (
    <div className="flex items-center gap-4">
      <button
        disabled={isPending}
        onClick={handleSimulate}
        className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-900 transition-colors hover:bg-zinc-300 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
      >
        {isPending ? "Simulating..." : "Simulate External Alert"}
      </button>
      
      {feedback && (
        <span className={`text-sm font-mono ${feedback.isError ? "text-red-500" : "text-zinc-500"}`}>
          {feedback.message}
        </span>
      )}
    </div>
  );
}