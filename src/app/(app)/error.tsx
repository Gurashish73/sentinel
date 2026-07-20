"use client";

import { signOut } from "next-auth/react";
import { startTransition } from "react";

/**
 * GLOBAL APP ERROR BOUNDARY (Client Component)
 * 
 * This boundary acts as the final safety net for the (app) route group. 
 * Its primary architectural purpose is to catch intentional security 
 * rejections thrown by the Data Access Layer (DAL) during server-side 
 * rendering and gracefully handle the resulting state.
 * 
 * When a user's database role is modified (e.g., COMMANDER -> OBSERVER) 
 * but their browser retains a stale JWT session cookie, the DAL will 
 * throw an authorization error. This component intercepts that error 
 * and programmatically wipes the stale cookie rather than trapping 
 * the user in an infinite re-render loop or displaying a generic 500 error.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Heuristic check to identify intentional authorization rejections from the DAL
  const looksLikeStaleAccess =
    error.message.includes("requires one of") || 
    error.message.includes("not a member") ||
    error.message.includes("Insufficient permissions");

  return (
    <main className="flex min-h-[50vh] flex-col items-center justify-center gap-6 px-6 text-center bg-zinc-950">
      <div className="text-zinc-200 text-sm">
        {looksLikeStaleAccess ? (
          <div className="space-y-2">
            <p className="text-amber-400 font-mono uppercase tracking-widest text-xs">
              Session Desync Detected
            </p>
            <p>Your access privileges have been modified in the database.</p>
            <p className="text-zinc-500">
              You must sign out to clear your stale token and re-authenticate.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-red-400 font-mono uppercase tracking-widest text-xs">
              Runtime Exception
            </p>
            <p>Something went wrong while loading this module.</p>
          </div>
        )}
      </div>
      
      {looksLikeStaleAccess ? (
        /* 
         * Security Mitigation: 
         * Physically clears the invalid JWT cookie from the browser and forces 
         * a fresh OAuth handshake via the /login route. 
         */
        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-400 hover:bg-amber-500/20 transition-colors"
        >
          Sign out & Re-authenticate
        </button>
      ) : (
        /* 
         * Graceful Degradation: 
         * Standard React error recovery wrapped in a transition to keep the UI 
         * responsive while Next.js attempts to re-render the Server Component.
         */
        <button
          onClick={() => startTransition(() => reset())}
          className="rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
        >
          Try again
        </button>
      )}
    </main>
  );
}