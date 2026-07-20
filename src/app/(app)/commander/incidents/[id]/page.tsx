import { requireRoleForActiveOrg } from "@/lib/dal";
import { IncidentDetail } from "@/components/incident-detail";

/**
 * COMMANDER INCIDENT DETAIL ROUTE (Server Component)
 * 
 * Dynamic route for viewing a specific incident. It enforces Commander-level 
 * access and safely passes mutation privileges down to the underlying UI components.
 */
export default async function CommanderIncidentPage({ 
  params 
}: { 
  // Leveraging the modern Next.js async params API for dynamic route segments
  params: Promise<{ id: string }> 
}) {
  const { id } = await params;
  
  // 1. Route-Level Security Boundary
  const { orgId } = await requireRoleForActiveOrg(["COMMANDER"]);
  
  return (
    <div className="mx-auto max-w-3xl">
      {/* 
        Reuses the universal IncidentDetail component. 
        canMutate={true} ensures the Commander gets the interactive status buttons. 
      */}
      <IncidentDetail incidentId={id} orgId={orgId} canMutate={true} />
    </div>
  );
}