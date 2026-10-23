import { redirect } from "next/navigation";
import { requireActiveOrg } from "@/lib/dal";

export default async function RootPage() {
  const { membership } = await requireActiveOrg();

  // Use the authoritative database role, not the session's potentially
  // stale JWT role, to choose the correct dashboard.
  redirect(`/${membership.role.toLowerCase()}/dashboard`);
}
