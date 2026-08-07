"use client";

import { Loader2 } from "lucide-react";

export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return (
    <span className="spinner" role="status" aria-label={label}>
      <Loader2 size={size} strokeWidth={2} aria-hidden="true" />
    </span>
  );
}
