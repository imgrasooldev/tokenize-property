"use client";

/** Opens the browser's print dialog (print or save as PDF). */
export function PrintButton({ label }: { label: string }) {
  return (
    <button type="button" className="btn" onClick={() => {
        window.print();
      }}>
      {label}
    </button>
  );
}
