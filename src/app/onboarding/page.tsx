import { requireSession } from "@/lib/dal";
import { db } from "@/lib/db";
import { CreateOrgForm } from "@/components/create-org-form";
import { redirect } from "next/navigation";

/**
 * ONBOARDING ROUTE (Server Component)
 * 
 * The catch-all landing page for authenticated users who have not yet 
 * provisioned or joined a workspace. It acts as a strict gateway, ensuring 
 * no user can access the main dashboard routes without an active organization.
 */
export default async function OnboardingPage() {
  // 1. Ensure the user is actually authenticated via Auth.js
  const session = await requireSession();

  // 2. Defense-in-Depth Routing
  // If a user already has a membership but manually navigates to /onboarding,
  // or if they hit the browser's back button after creating an org, 
  // immediately eject them back to the root application router.
  const existing = await db.membership.findFirst({ 
    where: { userId: session.user.id } 
  });
  
  if (existing) {
    redirect("/");
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 bg-zinc-950 text-zinc-50">
      <div className="text-center">
        <h1 className="text-2xl font-mono text-zinc-100 uppercase tracking-widest">
          Create Workspace
        </h1>
        <p className="mt-2 max-w-sm text-sm text-zinc-400">
          You will be assigned the System Commander role, granting full orchestration authority.
        </p>
      </div>
      
      {/* 
        The interactive Client Component containing the React 19 useActionState 
        logic that we wired up to src/actions/onboarding.ts 
      */}
      <CreateOrgForm />
    </main>
  );
}