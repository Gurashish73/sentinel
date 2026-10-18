"use client";

import { RouteSectionError } from "@/components/route-section-error";

export default function EngineerError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteSectionError section="Engineer" reset={reset} />;
}
