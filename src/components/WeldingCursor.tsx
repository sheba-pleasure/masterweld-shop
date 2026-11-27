import { useEffect, useRef, useState } from "react";

/**
 * Precision CAD welding crosshair cursor (fine pointer only, respects reduced-motion)
 * + GPU-composited scroll progress arc bar.
 */
export function WeldingChrome() {
  const dotRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const bar = barRef.current;

    const updateScroll = () => {
      if (!bar) return;
      const doc = document.documentElement;
      const max = doc.scrollHeight - window.innerHeight;
      const ratio = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      bar.style.transform = `scaleX(${ratio})`;
    };

    updateScroll();
    window.addEventListener("scroll", updateScroll, { passive: true });
    window.addEventListener("resize", updateScroll, { passive: true });

    const fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!fine || reduced) {
      return () => {
        window.removeEventListener("scroll", updateScroll);
        window.removeEventListener("resize", updateScroll);
      };
    }

    setEnabled(true);

    let targetX = -100;
    let targetY = -100;
    let ringX = -100;
    let ringY = -100;
    let visible = false;
    let interactive = false;
    let raf = 0;

    const interactiveSel = "a, button, input, select, textarea, summary, [data-magnetic='true']";

    const onMove = (e: PointerEvent) => {
      targetX = e.clientX;
      targetY = e.clientY;
      if (!visible) {
        ringX = targetX;
        ringY = targetY;
        visible = true;
      }
      const target = e.target;
      interactive = target instanceof HTMLElement && Boolean(target.closest(interactiveSel));
    };

    const onLeave = () => {
      visible = false;
    };

    const tick = () => {
      ringX += (targetX - ringX) * 0.2;
      ringY += (targetY - ringY) * 0.2;

      const dot = dotRef.current;
      const ring = ringRef.current;
      if (dot) {
        dot.style.opacity = visible ? "1" : "0";
        dot.style.transform = `translate3d(${targetX - 3}px, ${targetY - 3}px, 0) scale(${interactive ? 0.5 : 1})`;
      }
      if (ring) {
        ring.style.opacity = visible ? "1" : "0";
        ring.style.transform = `translate3d(${ringX - 18}px, ${ringY - 18}px, 0) scale(${interactive ? 1.45 : 1})`;
        ring.dataset["active"] = interactive ? "true" : "false";
      }

      raf = requestAnimationFrame(tick);
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerleave", onLeave);
    window.addEventListener("blur", onLeave);
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", updateScroll);
      window.removeEventListener("resize", updateScroll);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("blur", onLeave);
    };
  }, []);

  return (
    <>
      {/* GPU scroll progress arc line */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 top-0 z-50 h-[2px] bg-white/5"
      >
        <div
          ref={barRef}
          className="h-full origin-left bg-gradient-to-r from-mw-amber via-orange-400 to-mw-cyan will-change-transform"
          style={{ transform: "scaleX(0)" }}
        />
      </div>

      {/* Subtle fixed film grain overlay (GPU-safe fixed layer) */}
      <div aria-hidden="true" className="mw-film-grain pointer-events-none fixed inset-0 z-40" />

      {/* Precision CAD crosshair cursor */}
      {enabled && (
        <>
          <div
            ref={dotRef}
            aria-hidden="true"
            className="pointer-events-none fixed left-0 top-0 z-[80] h-1.5 w-1.5 rounded-full bg-mw-amber opacity-0 will-change-transform"
          />
          <div
            ref={ringRef}
            aria-hidden="true"
            data-active="false"
            className="mw-cursor-reticle pointer-events-none fixed left-0 top-0 z-[80] h-9 w-9 rounded-full border border-white/40 opacity-0 will-change-transform"
          />
        </>
      )}
    </>
  );
}
