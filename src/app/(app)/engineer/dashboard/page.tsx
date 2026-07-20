import { requireRoleForActiveOrg } from "@/lib/dal";
import { getIncidentsForOrg } from "@/lib/queries/incidents";
import { IncidentList } from "@/components/incident-list";
import { CreateIncidentForm } from "@/components/create-incident-form";
import Link from "next/link";

/**
 * ENGINEER DASHBOARD (Server Component)
 * 
 * The operational view for responders. Allows Commanders AND Engineers.
 * Notably omits the Settings navigational link, perfectly aligning the UI 
 * with our backend RBAC constraints.
 */
export default async function EngineerDashboardPage() {
  // Hierarchical security: Commanders can also view the engineering matrix
  const { orgId } = await requireRoleForActiveOrg(["COMMANDER", "ENGINEER"]);
  const incidents = await getIncidentsForOrg(orgId);

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-mono text-zinc-100 tracking-tight">Active Matrix</h1>
        <nav className="text-sm text-zinc-400 font-mono">
          <Link href="/engineer/runbooks" className="hover:text-zinc-200 transition-colors">
            Runbooks
          </Link>
        </nav>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-1">
          <CreateIncidentForm orgId={orgId} />
        </div>
        <div className="lg:col-span-2">
          {/* Component reuse: We pass the /engineer prefix so link routing adjusts dynamically */}
          <IncidentList incidents={incidents} basePath="/engineer" />
        </div>
      </div>
    </div>
  );
}