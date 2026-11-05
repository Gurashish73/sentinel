"use client";

import { IncidentPanelError } from "@/components/incident-panel-error";

export default function TimelineError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <IncidentPanelError
      panel="Incident timeline"
      reset={reset}
    />
  );
}