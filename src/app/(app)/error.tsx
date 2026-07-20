"use client";

/**
 * APP ERROR BOUNDARY (Client Component)
 * 
 * This catches any unhandled errors thrown during the rendering of the (app) 
 * route group. It is specifically designed to catch intentional authorization 
 * rejections from our Data Access Layer (src/lib/dal.ts).
 * 
 * If a user's database permissions change but their JWT session cookie is 
 * still active, this boundary detects the "stale state" and cleanly prompts 
 * a re-authentication rather than crashing with a 500 error.
 */

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Sniffs the error message for our specific DAL authorization rejections
  const looksLikeStaleAccess =
    error.message.includes("requires one of") || error.message.includes("not a member");

  return (
    <main className="flex min-h-[50vh] flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-neutral-200">
        {looksLikeStaleAccess
          ? "Your access may have changed. Sign out and back in to refresh your session."
          : "Something went wrong loading this page."}
      </p>
      <button
        onClick={reset}
        className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 transition-colors"
      >
        Try again
      </button>
    </main>
  );
}