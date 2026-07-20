import { getIncidentById } from "@/lib/queries/incidents";
import { notFound } from "next/navigation";
import { StatusControls } from "@/components/status-controls";

/**
 * INCIDENT DETAIL (Server Component)
 * 
 * A universal Server Component that fetches its own data. By colocating the 
 * data fetch with the component, we eliminate prop-drilling and ensure 
 * the multi-tenant `orgId` boundary is strictly enforced at the query level.
 * 
 * It accepts a `canMutate` boolean to dictate whether interactive controls 
 * (like updating the status) should be shipped to the client, perfectly 
 * separating the Observer role from Engineers/Commanders.
 */
export async function IncidentDetail({
  incidentId,
  orgId,
  canMutate,
}: {
  incidentId: string;
  orgId: string;
  canMutate: boolean;
}) {
  // The query enforces the orgId boundary. If an attacker guesses a valid 
  // incidentId from another org, this safely returns null.
  const incident = await getIncidentById(incidentId, orgId);

  if (!incident) notFound();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-neutral-100">{incident.title}</h1>
        <p className="mt-1 text-sm text-neutral-400">{incident.description}</p>
        <p className="mt-2 text-xs text-neutral-500">
          {incident.severity} · {incident.status}
        </p>
      </div>

      {/* Conditionally renders the interactive React Client Component */}
      {canMutate && (
        <StatusControls 
          incidentId={incident.id} 
          orgId={orgId} 
          currentStatus={incident.status} 
        />
      )}

      {/* Immutable Event Timeline */}
      <div>
        <h2 className="text-sm font-semibold text-neutral-300">Timeline</h2>
        <ul className="mt-2 space-y-2">
          {incident.events.map((event) => (
            <li key={event.id} className="text-xs text-neutral-500">
              <span className="font-mono text-neutral-400">{event.type}</span>{" "}
              — {new Date(event.createdAt).toLocaleString()}
            </li>
          ))}
          {incident.events.length === 0 && (
            <li className="text-xs text-neutral-600">No events recorded yet.</li>
          )}
        </ul>
      </div>
    </div>
  );
}