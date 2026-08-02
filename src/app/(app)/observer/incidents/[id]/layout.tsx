import { requireRoleForActiveOrg } from "@/lib/dal";
import { getIncidentById } from "@/lib/queries/incidents";
import { notFound } from "next/navigation";
import { IncidentStreamProvider } from "@/components/incident-stream-provider";
import type { ReactNode } from "react";

export default async function ObserverIncidentLayout({
  params,
  timeline,
  reasoning,
}: {
  params: Promise<{ id: string }>;
  timeline: ReactNode;
  reasoning: ReactNode;
}) {
  const { id: incidentId } = await params;
  const { orgId } = await requireRoleForActiveOrg(["COMMANDER", "ENGINEER", "OBSERVER"]);

  const incident = await getIncidentById(incidentId, orgId);
  if (!incident) notFound();

  return (
    <IncidentStreamProvider
      incidentId={incidentId}
      initialEvents={incident.events}
      initialStatus={incident.status}
    >
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div>{timeline}</div>
        <div>{reasoning}</div>
      </div>
    </IncidentStreamProvider>
  );
}