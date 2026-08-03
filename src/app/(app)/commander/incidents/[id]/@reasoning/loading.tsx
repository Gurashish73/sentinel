// Independent loading state for the reasoning feed
export default function ReasoningLoading() {
  return (
    <div className="animate-pulse space-y-2 rounded-md border border-neutral-800 p-4">
      <div className="h-4 w-1/3 rounded bg-neutral-800" />
      <div className="h-10 rounded bg-neutral-800" />
      <div className="h-10 rounded bg-neutral-800" />
    </div>
  );
}