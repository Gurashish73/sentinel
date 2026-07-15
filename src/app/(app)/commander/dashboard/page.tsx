export default function CommanderDashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-mono text-2xl font-bold tracking-tight text-zinc-100">
          Commander Command Bridge
        </h1>
        <p className="text-sm text-zinc-400">
          Full orchestration authority. Approve agent remediations and manage organization access.
        </p>
      </div>

      <div className="rounded-lg border border-dashed border-zinc-800 p-10 text-center">
        <div className="font-mono text-xs uppercase tracking-wider text-zinc-500">Action Queue</div>
        <p className="mt-1 text-sm text-zinc-400">No agent operations are currently awaiting human approval.</p>
      </div>
    </div>
  );
}