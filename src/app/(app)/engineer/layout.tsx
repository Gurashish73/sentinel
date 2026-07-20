/**
 * ENGINEER ROUTE LAYOUT
 * 
 * The visual wrapper for all /engineer routes. 
 * Uses amber-500 styling to create a distinct visual context from the 
 * emerald-400 Commander Bridge, reducing operator error.
 */
export default function EngineerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col space-y-6">
      <div className="border-b border-zinc-800 pb-4">
        <h2 className="text-sm font-mono text-amber-500 uppercase tracking-widest">
          Engineering Operations
        </h2>
      </div>
      {children}
    </div>
  );
}