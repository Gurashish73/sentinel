import { requireRoleForActiveOrg } from "@/lib/dal";
import { getRunbooksForOrg } from "@/lib/queries/runbooks";
import { CreateRunbookForm } from "@/components/create-runbook-form";

/**
 * COMMANDER RUNBOOKS ROUTE (Server Component)
 * 
 * The operational playbook library. This page allows Commanders to establish 
 * and distribute standard operating procedures (SOPs). In Phase 2, these 
 * runbooks will serve as the instruction set for autonomous AI agents.
 */
export default async function CommanderRunbooksPage() {
  // 1. Route-Level Security Boundary
  const { orgId } = await requireRoleForActiveOrg(["COMMANDER"]);
  
  // 2. Data Fetching (Leverages our tenant-scoped unstable_cache)
  const runbooks = await getRunbooksForOrg(orgId);

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <h1 className="text-2xl font-mono text-zinc-100 tracking-tight">Runbook Library</h1>
      
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-1">
          {/* React 19 Client Form for creating new runbooks */}
          <CreateRunbookForm orgId={orgId} />
        </div>
        
        <div className="lg:col-span-2 space-y-4">
          {runbooks.length === 0 ? (
            <p className="text-sm text-zinc-500 font-mono">No runbooks established.</p>
          ) : (
            runbooks.map((r) => (
              <div key={r.id} className="rounded-md border border-zinc-800 p-4 bg-zinc-900/30">
                <p className="font-mono text-zinc-100">{r.title}</p>
                {/* whitespace-pre-wrap ensures line breaks from the textarea are respected */}
                <p className="mt-2 text-sm text-zinc-400 whitespace-pre-wrap">{r.content}</p>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}