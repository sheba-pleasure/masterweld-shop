import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

/**
 * Tactile magnetic attraction wrapper for primary CTAs (fine pointer only).
 */
export function MagneticWrap({
  children,
  strength = 0.18,
  className = "",
}: {
  children: ReactNode;
  strength?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window === "undefined") return;
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!fine || reduced) return;

    let frame = 0;
    let tx = 0;
    let ty = 0;

    const commit = () => {
      el.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
      frame = 0;
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(commit);
    };

    const onMove = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      tx = (e.clientX - (rect.left + rect.width / 2)) * strength;
      ty = (e.clientY - (rect.top + rect.height / 2)) * strength;
      schedule();
    };

    const onLeave = () => {
      tx = 0;
      ty = 0;
      schedule();
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      el.style.transform = "";
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
    };
  }, [strength]);

  return (
    <div
      ref={ref}
      data-magnetic="true"
      className={`inline-block transition-transform duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * Cursor-tracked thermal spotlight card (updates --mx / --my CSS custom properties).
 */
export function SpotlightBezel({
  children,
  className = "",
  innerClassName = "",
}: {
  children: ReactNode;
  className?: string;
  innerClassName?: string;
}) {
  const handleMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--mx", `${e.clientX - rect.left}px`);
    e.currentTarget.style.setProperty("--my", `${e.clientY - rect.top}px`);
  };

  return (
    <div
      onPointerMove={handleMove}
      className={`bezel-outer bezel-outer--interactive mw-spotlight ${className}`}
    >
      <div className={`bezel-inner relative z-10 ${innerClassName}`}>{children}</div>
    </div>
  );
}
