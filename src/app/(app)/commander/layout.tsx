/**
 * COMMANDER ROUTE LAYOUT
 * 
 * Provides a consistent visual wrapper for all routes inside the /commander 
 * directory. Kept deliberately thin to ensure fast navigations between 
 * sub-pages (Dashboard, Runbooks, Settings).
 */
export default function CommanderLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col space-y-6">
      <div className="border-b border-zinc-800 pb-4">
        <h2 className="text-sm font-mono text-emerald-400 uppercase tracking-widest">
          Commander Bridge
        </h2>
      </div>
      {children}
    </div>
  );
}