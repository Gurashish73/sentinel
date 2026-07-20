import Link from "next/link";
import type { Incident } from "@prisma/client";

/**
 * INCIDENT LIST (Server Component)
 * 
 * A universally reusable Server Component that renders the core incident feed. 
 * By accepting a typed `basePath`, this single component powers the Commander, 
 * Engineer, and Observer dashboards without duplicating UI code.
 * 
 * Ships zero JavaScript to the client.
 */

// Dictionary pattern for constant time O(1) style lookups
const severityColor: Record<string, string> = {
  LOW: "bg-zinc-700 text-zinc-200",
  MEDIUM: "bg-amber-700 text-amber-100",
  HIGH: "bg-orange-700 text-orange-100",
  CRITICAL: "bg-red-700 text-red-100",
};

export function IncidentList({
  incidents,
  basePath,
}: {
  incidents: Incident[];
  // Strict union type guarantees valid routing across our multi-role architecture
  basePath: "/commander" | "/engineer" | "/observer";
}) {
  if (incidents.length === 0) {
    return <p className="text-sm text-neutral-400">No incidents yet.</p>;
  }

  return (
    <ul className="divide-y divide-neutral-800 rounded-md border border-neutral-800">
      {incidents.map((incident) => (
        <li key={incident.id}>
          <Link
            href={`${basePath}/incidents/${incident.id}`}
            className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-neutral-900"
          >
            <div>
              <p className="font-medium text-neutral-100">{incident.title}</p>
              <p className="text-xs text-neutral-500">
                {incident.status} · {new Date(incident.createdAt).toLocaleString()}
              </p>
            </div>
            <span
              className={`shrink-0 rounded px-2 py-0.5 text-xs font-semibold ${severityColor[incident.severity]}`}
            >
              {incident.severity}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}