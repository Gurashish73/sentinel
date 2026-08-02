"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, type ReactNode, type MouseEvent } from "react";

export function Modal({ children }: { children: ReactNode }) {
  const router = useRouter();
  const overlayRef = useRef<HTMLDivElement>(null);

  // Close on Escape key
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") router.back();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [router]);

  // Close on background click
  function onOverlayClick(e: MouseEvent) {
    if (e.target === overlayRef.current) router.back();
  }

  return (
    <div
      ref={overlayRef}
      onClick={onOverlayClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
    >
      <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-950 p-6 shadow-xl">
        <button onClick={() => router.back()} className="mb-4 text-xs text-neutral-500 hover:text-neutral-300">
          ✕ Close
        </button>
        {children}
      </div>
    </div>
  );
}