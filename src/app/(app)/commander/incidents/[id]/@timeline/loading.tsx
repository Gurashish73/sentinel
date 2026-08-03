// Independent loading state for the timeline side
export default function TimelineLoading() {
  return (
    <div className="animate-pulse space-y-3 rounded-md border border-neutral-800 p-4">
      <div className="h-5 w-2/3 rounded bg-neutral-800" />
      <div className="h-3 w-1/3 rounded bg-neutral-800" />
      <div className="h-3 w-1/2 rounded bg-neutral-800" />
    </div>
  );
}