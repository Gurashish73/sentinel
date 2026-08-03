import { requireRoleForActiveOrg } from "@/lib/dal";
import { getIncidentById } from "@/lib/queries/incidents";
import { notFound } from "next/navigation";
import { IncidentTimelinePanel } from "@/components/incident-timeline-panel";

export default async function ObserverTimelineSlot({ params }: { params: Promise<{ id: string }> }) {
  const { id: incidentId } = await params;
  const { orgId } = await requireRoleForActiveOrg(["COMMANDER", "ENGINEER", "OBSERVER"]);

  const incident = await getIncidentById(incidentId, orgId);
  if (!incident) notFound();

  return <IncidentTimelinePanel incident={incident} orgId={orgId} role="OBSERVER" />;
}