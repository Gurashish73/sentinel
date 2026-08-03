import { requireRoleForActiveOrg } from "@/lib/dal";
import { getIncidentById } from "@/lib/queries/incidents";
import { notFound } from "next/navigation";
import { Modal } from "@/components/modal";

export default async function CommanderIncidentModal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId } = await requireRoleForActiveOrg(["COMMANDER"]);

  const incident = await getIncidentById(id, orgId);
  if (!incident) notFound();

  return (
    <Modal>
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-neutral-100">{incident.title}</h2>
          <p className="mt-1 text-sm text-neutral-400">{incident.description}</p>
          <p className="mt-2 text-xs text-neutral-500">
            {incident.severity} · {incident.status}
          </p>
        </div>
        
        <a
          href={`/commander/incidents/${incident.id}`}
          className="inline-block text-xs text-emerald-400 hover:underline"
        >
          Open full interactive view →
        </a>
      </div>
    </Modal>
  );
}