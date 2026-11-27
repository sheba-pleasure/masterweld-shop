import { useCallback, useEffect, useState } from "react";
import { MasterWeldMark } from "@/components/icons/MasterWeldLogo";
import { INTRO_SEEN_KEY, REPLAY_INTRO_EVENT } from "@/lib/arc-intro";

export function ArcIgnitionLoader() {
  const [phase, setPhase] = useState<"idle" | "running" | "exiting" | "done">("idle");
  const [progress, setProgress] = useState(0);

  const startSequence = useCallback(() => {
    setProgress(0);
    setPhase("running");
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setPhase("done");
      return;
    }

    const onReplay = () => startSequence();
    window.addEventListener(REPLAY_INTRO_EVENT, onReplay);

    let seen = false;
    try {
      seen = sessionStorage.getItem(INTRO_SEEN_KEY) === "1";
    } catch {
      seen = false;
    }

    if (seen) {
      setPhase("done");
    } else {
      startSequence();
    }

    return () => window.removeEventListener(REPLAY_INTRO_EVENT, onReplay);
  }, [startSequence]);

  useEffect(() => {
    if (phase !== "running") return;

    const duration = 1250;
    const startedAt = performance.now();
    let rafId = 0;

    const tick = (now: number) => {
      const elapsed = now - startedAt;
      const t = Math.min(1, elapsed / duration);
      // Cubic ease-out amperage ramp
      const eased = 1 - Math.pow(1 - t, 3);
      setProgress(eased * 100);

      if (t < 1) {
        rafId = requestAnimationFrame(tick);
      } else {
        try {
          sessionStorage.setItem(INTRO_SEEN_KEY, "1");
        } catch {
          // Ignore private mode storage denials
        }
        setPhase("exiting");
      }
    };

    rafId = requestAnimationFrame(tick);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        cancelAnimationFrame(rafId);
        setProgress(100);
        setPhase("exiting");
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("keydown", onKey);
    };
  }, [phase]);

  useEffect(() => {
    if (phase !== "exiting") return;
    const timer = window.setTimeout(() => setPhase("done"), 680);
    return () => window.clearTimeout(timer);
  }, [phase]);

  if (phase === "idle" || phase === "done") return null;

  const amps = Math.round((progress / 100) * 350);
  const volts = (14 + (progress / 100) * 17.5).toFixed(1);
  const pct = Math.round(progress);
  const exiting = phase === "exiting";

  return (
    <div
      role="presentation"
      onClick={() => setPhase("exiting")}
      className={`mw-preloader fixed inset-0 z-[90] flex flex-col justify-between overflow-hidden bg-mw-void p-6 text-foreground md:p-10 ${
        exiting ? "mw-preloader--exit" : ""
      }`}
    >
      {/* Blueprint CAD grid */}
      <div className="mw-blueprint-grid pointer-events-none absolute inset-0 opacity-60" />

      {/* Corner registration crosshairs */}
      <span className="pointer-events-none absolute left-5 top-5 font-mono text-[10px] text-white/25">
        +
      </span>
      <span className="pointer-events-none absolute right-5 top-5 font-mono text-[10px] text-white/25">
        +
      </span>
      <span className="pointer-events-none absolute bottom-5 left-5 font-mono text-[10px] text-white/25">
        +
      </span>
      <span className="pointer-events-none absolute bottom-5 right-5 font-mono text-[10px] text-white/25">
        +
      </span>

      {/* Top engineering strip */}
      <div className="relative z-10 flex w-full items-center justify-between border-b border-white/10 pb-4 font-mono text-[10px] uppercase tracking-[0.24em] text-mw-amber">
        <span>МАСТЕР СВАРЩИК // ARC SYSTEM</span>
        <span className="text-muted-foreground">EST. 1993 // MSK</span>
      </div>

      {/* Center ignition stage */}
      <div className="relative z-10 mx-auto my-auto flex w-full max-w-2xl flex-col items-center text-center">
        <div className="relative mb-6 flex items-center justify-center">
          <div className="mw-loader-halo pointer-events-none absolute h-32 w-32 rounded-full" />
          <MasterWeldMark size={76} animated className="relative text-white" />
        </div>

        <p className="font-display text-[clamp(1.65rem,5vw,3.4rem)] font-bold uppercase tracking-tight text-white">
          Мастер Сварщик
        </p>
        <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.32em] text-mw-cyan">
          Сварочное оборудование и расходники
        </p>

        {/* Amperage / Drafting ruler bar */}
        <div className="mt-12 w-full max-w-lg">
          <div className="mb-3 flex items-center justify-between font-mono text-xs tabular-nums">
            <span className="text-muted-foreground">
              ARC_LOAD: <strong className="text-white">{String(amps).padStart(3, "0")} А</strong> /{" "}
              <span className="text-mw-cyan">{volts} В</span>
            </span>
            <span className="font-semibold text-mw-amber">{pct}%</span>
          </div>

          <div className="flex w-full items-center">
            <span className="h-4 w-px bg-white/30" />
            <div className="relative mx-1 h-[2px] flex-1 bg-white/12">
              <div
                className="h-full bg-gradient-to-r from-mw-amber via-orange-400 to-mw-cyan transition-[width] duration-75"
                style={{ width: `${progress}%` }}
              />
              <span
                className="pointer-events-none absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full bg-mw-cyan shadow-[0_0_14px_var(--mw-cyan)]"
                style={{ left: `calc(${progress}% - 5px)` }}
              />
            </div>
            <span className="h-4 w-px bg-white/30" />
          </div>
        </div>
      </div>

      {/* Bottom status strip */}
      <div className="relative z-10 flex w-full items-end justify-between border-t border-white/10 pt-4 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        <span className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-mw-emerald animate-ping" />
          <span>IGNITION: READY</span>
        </span>
        <span>НАЖМИТЕ ДЛЯ ПРОПУСКА</span>
      </div>
    </div>
  );
}
