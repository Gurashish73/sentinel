import { requireRoleForActiveOrg } from "@/lib/dal";
import { getIncidentsForOrg } from "@/lib/queries/incidents";
import { IncidentList } from "@/components/incident-list";
import { CreateIncidentForm } from "@/components/create-incident-form";

/**
 * COMMANDER DASHBOARD (Server Component)
 * 
 * The primary mission control for organization leaders. 
 * Strictly enforces the "COMMANDER" role at the route level before 
 * fetching the tenant-scoped incident matrix.
 */
export default async function CommanderDashboardPage() {
  // 1. Route-Level Security Boundary
  // Rejects unauthorized access before any UI is rendered.
  const { orgId } = await requireRoleForActiveOrg(["COMMANDER"]);
  
  // 2. Data Fetching
  const incidents = await getIncidentsForOrg(orgId);

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      {/* Navigation Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-mono text-zinc-100 tracking-tight">Active Matrix</h1>
      </div>

      {/* 
        Dashboard Grid
        Combines our React 19 Client Form with our Server-Rendered List.
      */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-1">
          <CreateIncidentForm orgId={orgId} />
        </div>
        <div className="lg:col-span-2">
          {/* Reusing our universal list component, routing clicks to the commander prefix */}
          <IncidentList incidents={incidents} basePath="/commander" />
        </div>
      </div>
    </div>
  );
}