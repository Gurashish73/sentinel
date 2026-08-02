import { requireRoleForActiveOrg } from "@/lib/dal";
import { getIncidentById } from "@/lib/queries/incidents";
import { notFound } from "next/navigation";
import { IncidentStreamProvider } from "@/components/incident-stream-provider";
import type { ReactNode } from "react";

/**
 * COMMANDER INCIDENT LAYOUT
 * 
 * Replaces the traditional page.tsx. Acts as the data boundary for the SSE stream,
 * fetching the initial database state and wrapping the Parallel Route slots 
 * (@timeline and @reasoning) in the React Context Provider.
 */
export default async function CommanderIncidentLayout({
  params,
  timeline,
  reasoning,
}: {
  params: Promise<{ id: string }>;
  timeline: ReactNode;
  reasoning: ReactNode;
}) {
  const { id: incidentId } = await params;
  const { orgId } = await requireRoleForActiveOrg(["COMMANDER"]);

  const incident = await getIncidentById(incidentId, orgId);
  if (!incident) notFound();

  return (
    <IncidentStreamProvider
      incidentId={incidentId}
      initialEvents={incident.events}
      initialStatus={incident.status}
    >
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        {/* These render the page.tsx files from the @timeline and @reasoning folders */}
        <div>{timeline}</div>
        <div>{reasoning}</div>
      </div>
    </IncidentStreamProvider>
  );
}