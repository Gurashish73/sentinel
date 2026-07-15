export default function ObserverDashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-mono text-2xl font-bold tracking-tight text-zinc-100">
          Observer Matrix
        </h1>
        <p className="text-sm text-zinc-400">
          Read-only system monitoring stream. Elevated actions are locked.
        </p>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6">
        <div className="flex items-center gap-3 text-amber-400 font-mono text-xs uppercase tracking-wider">
          <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
          Awaiting Assignment
        </div>
        <p className="mt-2 text-sm text-zinc-300">
          Your profile has been registered securely. A System Commander must assign you to an active organization workspace to view incidents.
        </p>
      </div>
    </div>
  );
}