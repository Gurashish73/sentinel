import { requireRoleForActiveOrg } from "@/lib/dal";
import { getRunbooksForOrg } from "@/lib/queries/runbooks";
import { CreateRunbookForm } from "@/components/create-runbook-form";

/**
 * ENGINEER RUNBOOKS ROUTE (Server Component)
 * 
 * Allows Engineers to view and contribute to the system's operational 
 * playbook alongside Commanders.
 */
export default async function EngineerRunbooksPage() {
  const { orgId } = await requireRoleForActiveOrg(["COMMANDER", "ENGINEER"]);
  const runbooks = await getRunbooksForOrg(orgId);

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <h1 className="text-2xl font-mono text-zinc-100 tracking-tight">Runbook Library</h1>
      
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-1">
          <CreateRunbookForm orgId={orgId} />
        </div>
        <div className="lg:col-span-2 space-y-4">
          {runbooks.length === 0 ? (
            <p className="text-sm text-zinc-500 font-mono">No runbooks established.</p>
          ) : (
            runbooks.map((r) => (
              <div key={r.id} className="rounded-md border border-zinc-800 p-4 bg-zinc-900/30">
                <p className="font-mono text-zinc-100">{r.title}</p>
                <p className="mt-2 text-sm text-zinc-400 whitespace-pre-wrap">{r.content}</p>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}