import { requireRoleForActiveOrg } from "@/lib/dal";
import { db } from "@/lib/db";
import { OrgSettingsForm } from "@/components/org-settings-form";
import { notFound } from "next/navigation";

/**
 * COMMANDER SETTINGS ROUTE (Server Component)
 * 
 * The cryptographic configuration hub. Strictly protected by the COMMANDER role.
 * Fetches the raw organization data to populate the settings form.
 */
export default async function CommanderSettingsPage() {
  const { orgId } = await requireRoleForActiveOrg(["COMMANDER"]);
  const org = await db.organization.findUnique({ where: { id: orgId } });
  
  // Graceful degradation if the tenant ID somehow drops or desyncs
  if (!org) notFound();

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-mono text-zinc-100 tracking-tight">System Configuration</h1>
      {/* Offloads the interactive form logic to our React 19 Client Component */}
      <OrgSettingsForm orgId={orgId} currentName={org.name} />
    </div>
  );
}