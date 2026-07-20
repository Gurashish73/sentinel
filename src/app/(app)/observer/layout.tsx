/**
 * OBSERVER ROUTE LAYOUT
 * 
 * Provides a distinct, muted visual context (zinc-500) to explicitly signal 
 * to the user that they are in a Read-Only environment, managing expectations 
 * before they even view the data.
 */
export default function ObserverLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col space-y-6">
      <div className="border-b border-zinc-800 pb-4">
        <h2 className="text-sm font-mono text-zinc-500 uppercase tracking-widest">
          Observer Matrix (Read-Only)
        </h2>
      </div>
      {children}
    </div>
  );
}