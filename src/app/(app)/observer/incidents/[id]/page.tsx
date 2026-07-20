import { requireRoleForActiveOrg } from "@/lib/dal";
import { IncidentDetail } from "@/components/incident-detail";

/**
 * OBSERVER INCIDENT DETAIL ROUTE (Server Component)
 * 
 * Dynamic route for stakeholders to monitor an ongoing situation.
 */
export default async function ObserverIncidentPage({ 
  params 
}: { 
  params: Promise<{ id: string }> 
}) {
  const { id } = await params;
  const { orgId } = await requireRoleForActiveOrg(["COMMANDER", "ENGINEER", "OBSERVER"]);
  
  return (
    <div className="mx-auto max-w-3xl">
      {/* 
        canMutate={false} ensures that the interactive StatusControls 
        are completely stripped from the server-rendered HTML. 
      */}
      <IncidentDetail incidentId={id} orgId={orgId} canMutate={false} />
    </div>
  );
}