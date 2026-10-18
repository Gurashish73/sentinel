"use client";

import { RouteSectionError } from "@/components/route-section-error";

export default function ObserverError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteSectionError section="Observer" reset={reset} />;
}
