"use client";

export function PrintButton() {
  return (
    <button
      onClick={() => window.print()}
      className="rounded-md bg-paper px-4 py-2 text-sm font-medium text-vault transition-colors hover:bg-white"
    >
      Print or save as PDF
    </button>
  );
}
