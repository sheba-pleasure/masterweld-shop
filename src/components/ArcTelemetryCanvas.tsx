import { useEffect, useRef, useState } from "react";
import {
  ArcInverterIcon,
  MigTorchIcon,
  PlasmaCutIcon,
  TigArcIcon,
} from "@/components/icons/WeldingIcons";

type ArcModeKey = "mig" | "tig" | "mma" | "cut";

const ARC_MODES: {
  key: ArcModeKey;
  label: string;
  amps: string;
  volts: string;
  freq: string;
  note: string;
}[] = [
  {
    key: "mig",
    label: "MIG/MAG",
    amps: "240 А",
    volts: "25.4 В",
    freq: "120 Гц",
    note: "Импульсный перенос капли",
  },
  {
    key: "tig",
    label: "TIG AC/DC",
    amps: "185 А",
    volts: "17.8 В",
    freq: "80 Гц",
    note: "Стабильная дуга в аргоне",
  },
  {
    key: "mma",
    label: "MMA",
    amps: "160 А",
    volts: "26.2 В",
    freq: "DC",
    note: "Форсаж дуги и горячий старт",
  },
  {
    key: "cut",
    label: "CUT",
    amps: "95 А",
    volts: "118 В",
    freq: "HF",
    note: "Плазменный рез сжатым воздухом",
  },
];

export function ArcTelemetryCanvas({ compact = false }: { compact?: boolean }) {
  const [mode, setMode] = useState<ArcModeKey>("mig");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const current = ARC_MODES.find((m) => m.key === mode) ?? ARC_MODES[0]!;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof window === "undefined") return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let phase = 0;

    const draw = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      // Oscilloscope graticule
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      for (let x = 24; x < w; x += 36) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();

      // Secondary cyan voltage wave
      ctx.beginPath();
      ctx.strokeStyle = "rgba(0, 229, 255, 0.45)";
      ctx.lineWidth = 1.4;
      for (let x = 0; x < w; x += 2) {
        const t = x * 0.045 + phase * 1.1;
        const vWave =
          mode === "cut"
            ? Math.sin(t * 2.6) * 7
            : mode === "tig"
              ? Math.sign(Math.sin(t * 0.9)) * 9
              : Math.sin(t) * 10;
        const y = h * 0.56 + vWave;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Primary amber current wave
      ctx.beginPath();
      ctx.strokeStyle = "#ff5500";
      ctx.lineWidth = 2.2;
      ctx.shadowColor = "rgba(255, 85, 0, 0.55)";
      ctx.shadowBlur = 10;
      for (let x = 0; x < w; x += 2) {
        const t = x * 0.06 + phase * 1.8;
        let amp = 0;
        if (mode === "mig") {
          amp = Math.pow(Math.max(0, Math.sin(t)), 4) * 24 - 10;
        } else if (mode === "tig") {
          amp = Math.sin(t * 1.4) > 0 ? -15 : 11;
        } else if (mode === "mma") {
          amp = Math.sin(t * 0.8) * 9 + Math.sin(t * 3.7) * 4;
        } else {
          amp = -12 + Math.sin(t * 5.2) * 5 + Math.cos(t * 2.1) * 3;
        }
        const y = h * 0.48 + amp;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      if (!reduced) {
        phase += 0.045;
        frame = requestAnimationFrame(draw);
      }
    };

    draw();
    return () => {
      if (frame) cancelAnimationFrame(frame);
    };
  }, [mode]);

  return (
    <div className="bezel-outer">
      <div className={`bezel-inner relative overflow-hidden ${compact ? "p-4" : "p-5"}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-mw-cyan">
            <span className="h-2 w-2 rounded-full bg-mw-amber shadow-[0_0_8px_var(--mw-amber)]" />
            <span>Осциллограмма дуги</span>
          </div>
          <span className="font-mono text-[11px] text-muted-foreground">{current.note}</span>
        </div>

        {/* Mode selector with custom hardware SVG icons */}
        <div className="mt-3 grid grid-cols-4 gap-1.5">
          {ARC_MODES.map((m) => {
            const active = m.key === mode;
            return (
              <button
                key={m.key}
                type="button"
                aria-pressed={active}
                onClick={() => setMode(m.key)}
                className={`flex items-center justify-center gap-1.5 rounded-xl border px-2 py-2 font-mono text-[11px] font-semibold transition-[border-color,background-color,color] duration-150 ${
                  active
                    ? "border-mw-amber bg-mw-amber/18 text-white"
                    : "border-white/10 bg-mw-void/70 text-muted-foreground hover:border-white/25 hover:text-white"
                }`}
              >
                {m.key === "mig" && <MigTorchIcon size={14} />}
                {m.key === "tig" && <TigArcIcon size={14} />}
                {m.key === "mma" && <ArcInverterIcon size={14} />}
                {m.key === "cut" && <PlasmaCutIcon size={14} />}
                <span>{m.label}</span>
              </button>
            );
          })}
        </div>

        {/* Live canvas */}
        <div className="mt-3 overflow-hidden rounded-xl border border-white/10 bg-mw-void/95 p-2">
          <canvas
            ref={canvasRef}
            width={420}
            height={compact ? 64 : 88}
            className={`w-full ${compact ? "h-16" : "h-[88px]"}`}
          />
        </div>

        {/* Readout strip */}
        <div className="mt-3 grid grid-cols-3 gap-2 font-mono text-xs tabular-nums">
          <div className="rounded-xl border border-white/8 bg-mw-void/80 px-3 py-2">
            <div className="text-[10px] uppercase text-muted-foreground">Ток</div>
            <div className="mt-0.5 font-semibold text-white">{current.amps}</div>
          </div>
          <div className="rounded-xl border border-white/8 bg-mw-void/80 px-3 py-2">
            <div className="text-[10px] uppercase text-muted-foreground">Напряжение</div>
            <div className="mt-0.5 font-semibold text-mw-cyan">{current.volts}</div>
          </div>
          <div className="rounded-xl border border-white/8 bg-mw-void/80 px-3 py-2">
            <div className="text-[10px] uppercase text-muted-foreground">Режим</div>
            <div className="mt-0.5 font-semibold text-mw-amber">{current.freq}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
