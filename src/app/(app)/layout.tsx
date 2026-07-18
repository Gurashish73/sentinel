import { requireActiveOrg } from "@/lib/dal";
import React from "react";

export default async function AuthenticatedShellLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Defense-in-Depth: Authoritative server-side check.
  // This enforces BOTH authentication AND organization membership.
  // If the user has no org, it intercepts and routes to /onboarding,
  // preventing Prisma cross-tenant leaks before any UI is rendered.
  const { session, orgId } = await requireActiveOrg();

  return (
    <div className="flex h-full min-h-screen flex-col lg:flex-row bg-zinc-950">
      {/* Shared Sidebar Navigation */}
      <aside className="flex w-full shrink-0 flex-col justify-between border-b border-zinc-800 p-4 lg:w-64 lg:border-b-0 lg:border-r">
        <div>
          <div className="font-mono text-xs uppercase tracking-widest text-zinc-500">
            Sentinel OS
          </div>
          <nav className="mt-8 flex flex-col gap-4">
            {/* Nav placeholders - will be wired to dynamic route paths based on role */}
            <div className="text-sm font-medium text-zinc-200">Dashboard</div>
            <div className="text-sm text-zinc-500">Active Incidents</div>
            <div className="text-sm text-zinc-500">Runbook Library</div>
          </nav>
        </div>
        
        {/* Session Context UI - Now populated safely via the DAL */}
        <div className="mt-8 border-t border-zinc-800 pt-4 lg:mt-auto">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
            Current Session
          </div>
          <div className="truncate text-sm font-medium text-zinc-200">
            {session.user.email}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="rounded bg-emerald-400/10 px-2 py-0.5 font-mono text-[10px] text-emerald-400">
              {session.user.role ?? "PENDING_ROLE"}
            </span>
            <span className="truncate rounded bg-zinc-800 px-2 py-0.5 font-mono text-[10px] text-zinc-400">
              {orgId ?? "PENDING_ORG"}
            </span>
          </div>
        </div>
      </aside>
      
      {/* Main Content Boundary - Scrolls independently of the sidebar */}
      <main className="flex-1 overflow-y-auto p-6 lg:p-10 text-zinc-50">
        {children}
      </main>
    </div>
  );
}