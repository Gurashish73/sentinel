"use client";

import { IncidentPanelError } from "@/components/incident-panel-error";

export default function ReasoningError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <IncidentPanelError
      panel="Agent reasoning feed"
      reset={reset}
    />
  );
}