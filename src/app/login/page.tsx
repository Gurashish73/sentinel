import { signIn } from "@/auth";

export default function LoginPage() {
  return (
    <main className="flex h-full flex-col items-center justify-center gap-8 px-6 text-center">
      <div>
        <h1 className="font-mono text-4xl font-semibold tracking-tighter text-zinc-100">
          Sentinel OS
        </h1>
        <p className="mt-4 max-w-md text-sm text-zinc-400">
          Autonomous incident investigation, gated behind human approval.
        </p>
      </div>
      
      {/* 
        Using Next.js Server Actions for secure sign-in. 
        This completely bypasses the need for client-side React state.
      */}
      <form
        action={async () => {
          "use server";
          // After successful login, redirect to root so our middleware 
          // can smart-route them to their specific role dashboard.
          await signIn("github", { redirectTo: "/" });
        }}
      >
        <button 
          type="submit" 
          className="rounded-md bg-zinc-100 px-6 py-2.5 text-sm font-semibold text-zinc-900 transition-colors hover:bg-zinc-300 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-zinc-950"
        >
          Authenticate via GitHub
        </button>
      </form>
    </main>
  );
}