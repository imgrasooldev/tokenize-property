"use client";

import { useState } from "react";

/** Copies a short value (a receive code) to the clipboard; says so for two seconds. */
export function CopyButton({ value, label, done }: { value: string; label: string; done: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <button type="button" className="btn secondary small" onClick={() => void copy()} aria-live="polite">
      {copied ? done : label}
    </button>
  );
}
