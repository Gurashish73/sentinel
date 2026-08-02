"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function DashboardAutoRefresh({ hasActiveIncidents }: { hasActiveIncidents: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!hasActiveIncidents) return;
    const id = setInterval(() => router.refresh(), 8000);
    return () => clearInterval(id);
  }, [hasActiveIncidents, router]);
  return null;
}