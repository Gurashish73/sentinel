export default function EngineerDashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-mono text-2xl font-bold tracking-tight text-zinc-100">
          Engineer Tactical Center
        </h1>
        <p className="text-sm text-zinc-400">
          Monitor system alerts, review agent runbooks, and declare incidents.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-6">
          <div className="text-xs font-mono uppercase tracking-widest text-zinc-500">Active Incidents</div>
          <div className="mt-2 text-3xl font-semibold font-mono text-zinc-100">0</div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-6">
          <div className="text-xs font-mono uppercase tracking-widest text-zinc-500">Agent Operations Running</div>
          <div className="mt-2 text-3xl font-semibold font-mono text-emerald-400">Idle</div>
        </div>
      </div>
    </div>
  );
}