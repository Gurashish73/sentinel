import { requireRoleForActiveOrg } from "@/lib/dal";
import { IncidentDetail } from "@/components/incident-detail";

/**
 * ENGINEER INCIDENT DETAIL ROUTE (Server Component)
 * 
 * Async dynamic route for responders to investigate specific incidents.
 */
export default async function EngineerIncidentPage({ 
  params 
}: { 
  params: Promise<{ id: string }> 
}) {
  const { id } = await params;
  const { orgId } = await requireRoleForActiveOrg(["COMMANDER", "ENGINEER"]);
  
  return (
    <div className="mx-auto max-w-3xl">
      {/* 
        canMutate={true} renders the StatusControls. 
        Even though it renders, our backend Server Action (actions/incidents.ts) 
        still acts as the ultimate guardrail, preventing Engineers from marking 
        an incident as fully "RESOLVED".
      */}
      <IncidentDetail incidentId={id} orgId={orgId} canMutate={true} />
    </div>
  );
}