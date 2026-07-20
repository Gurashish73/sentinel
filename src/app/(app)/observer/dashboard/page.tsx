import { requireRoleForActiveOrg } from "@/lib/dal";
import { getIncidentsForOrg } from "@/lib/queries/incidents";
import { IncidentList } from "@/components/incident-list";

/**
 * OBSERVER DASHBOARD (Server Component)
 * 
 * A strictly read-only view of the active incident matrix. 
 * Form components are entirely omitted to reduce payload size and 
 * physically prevent unauthorized mutation attempts from the client.
 */
export default async function ObserverDashboardPage() {
  // Broadest RBAC check: Allows all roles to view the read-only dashboard
  const { orgId } = await requireRoleForActiveOrg(["COMMANDER", "ENGINEER", "OBSERVER"]);
  const incidents = await getIncidentsForOrg(orgId);

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <h1 className="text-2xl font-mono text-zinc-100 tracking-tight">System Status Overview</h1>
      <div className="w-full">
        {/* Universal list component configured for observer routing */}
        <IncidentList incidents={incidents} basePath="/observer" />
      </div>
    </div>
  );
}