"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

/** Minimum distance between the panel and the viewport edge, matching the page gutter. */
const GUTTER = 16;

/**
 * Disclosure popover: a button that toggles a non-modal panel. Escape and outside clicks close it,
 * and Escape returns focus to the trigger. The panel is shifted back inside the viewport when its preferred
 * alignment would overflow, so it never scrolls the page sideways.
 */
export function Popover({
  label,
  trigger,
  triggerClassName,
  align = "end",
  onOpen,
  children,
}: {
  /** Accessible name for the panel. */
  label: string;
  trigger: React.ReactNode;
  triggerClassName: string;
  align?: "start" | "end";
  onOpen?: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = panel.current;
    if (!open || !el) return;
    const place = () => {
      el.style.translate = "";
      const { left, right } = el.getBoundingClientRect();
      const viewport = document.documentElement.clientWidth;
      const shift = right > viewport - GUTTER ? viewport - GUTTER - right : left < GUTTER ? GUTTER - left : 0;
      el.style.translate = shift ? `${Math.max(GUTTER - left, shift)}px 0` : "";
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onFocus = (e: FocusEvent) => {
      if (e.target instanceof Node && !root.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen((o) => !o);
        }}
        className={triggerClassName}
      >
        {trigger}
        <svg viewBox="0 0 10 10" className={`h-2.5 w-2.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden>
          <path d="m2 3.75 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      <div
        ref={panel}
        id={id}
        role="region"
        aria-label={label}
        hidden={!open}
        className={`absolute top-full z-30 mt-2 w-[min(20rem,calc(100vw-2rem))] rounded-md border border-rule bg-panel-2 p-4 text-sm shadow-[0_12px_32px_rgba(0,0,0,0.45)] ${
          align === "end" ? "right-0" : "left-0"
        }`}
      >
        {children}
      </div>
    </div>
  );
}
