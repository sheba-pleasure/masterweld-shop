import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import plate from "@/assets/brand/living-workshop-plate.webp";
import mark from "@/assets/brand/living-workshop-mark.webp";
import fume from "@/assets/brand/living-workshop-fume.webp";

// A cinemagraph: photographic layers keep the lettering stable, only light/vapor/embers move.
export function LivingWorkshop() {
  const host = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const pause = useRef<((value: boolean) => void) | null>(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const root = host.current;
    const photo = image.current;
    const surface = canvas.current;
    if (!root || !photo || !surface) return;
    const context = surface.getContext("2d", { alpha: true });
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let width = 1,
      height = 1,
      x = 0,
      y = 0,
      unit = 1;
    let frame = 0,
      frames = 0,
      last = 0,
      elapsed = 0;
    let stopped = false,
      visible = true,
      disposed = false;
    const seeds = Array.from({ length: 106 }, (_, i) => {
      const random = (n: number) => {
        const value = Math.sin(i * n + 17.13) * 43758.5453;
        return value - Math.floor(value);
      };
      return { a: random(127.1), b: random(269.5), c: random(83.1), period: [1, 4 / 3, 2][i % 3]! };
    });
    const position = (age: number, seed: (typeof seeds)[number]) => {
      const vx = (-70 - seed.a * 190) * unit;
      const vy = (-80 + seed.b * 180) * unit;
      const gravity = 330 * unit;
      const floor = 76 * unit;
      const impact = (-vy + Math.sqrt(vy * vy + 2 * gravity * floor)) / gravity;
      let drop = vy * age + (gravity * age * age) / 2;
      if (age > impact) {
        const after = age - impact;
        drop = floor - (vy + gravity * impact) * 0.24 * after + (gravity * after * after) / 2;
      }
      return { x: x + vx * age, y: y + drop };
    };
    const draw = (now: number) => {
      frame = 0;
      if (disposed || stopped || !visible || document.hidden || reduced.matches || !context) return;
      if (last) elapsed += Math.min((now - last) / 1000, 0.05);
      last = now;
      const time = elapsed % 8;
      context.clearRect(0, 0, width, height);
      context.globalCompositeOperation = "lighter";
      const count = width < 760 ? 62 : seeds.length;
      for (let i = 0; i < count; i++) {
        const seed = seeds[i]!;
        const age = (time + seed.c * seed.period) % seed.period;
        const life = age / seed.period;
        const heat = Math.pow(1 - life, 0.85);
        const current = position(age, seed);
        const previous = position(Math.max(0, age - 0.016 - seed.b * 0.022), seed);
        const alpha = Math.min(1, age * 30) * heat * (0.55 + seed.c * 0.45);
        context.lineWidth = (0.55 + seed.c * 0.8) * Math.min(1.4, unit);
        context.strokeStyle = `rgba(255,${Math.round(100 + heat * 145)},${Math.round(20 + heat * heat * 145)},${alpha})`;
        context.beginPath();
        context.moveTo(previous.x, previous.y);
        context.lineTo(current.x, current.y);
        context.stroke();
        if (i % 5 === 0) {
          context.fillStyle = `rgba(255,218,157,${alpha * 0.65})`;
          context.beginPath();
          context.arc(current.x, current.y, 1.05 * Math.min(unit, 1.4), 0, Math.PI * 2);
          context.fill();
        }
      }
      root.dataset["frames"] = String(++frames);
      frame = requestAnimationFrame(draw);
    };
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      last = 0;
      const active = !disposed && !stopped && visible && !document.hidden && !reduced.matches;
      root.dataset["motion"] = active ? "playing" : "paused";
      if (active && context) frame = requestAnimationFrame(draw);
    };
    const resize = () => {
      const bounds = root.getBoundingClientRect();
      width = bounds.width;
      height = bounds.height;
      if (!width || !height) return;
      const mobile = width < 760;
      const sceneHeight = mobile ? 350 : height;
      const sceneTop = height - sceneHeight;
      const sourceWidth = photo.naturalWidth || 2099,
        sourceHeight = photo.naturalHeight || 749;
      const scale = Math.max(width / sourceWidth, sceneHeight / sourceHeight);
      const imageWidth = sourceWidth * scale,
        imageHeight = sourceHeight * scale;
      const left = (width - imageWidth) * (mobile ? 0.825 : width < 1100 ? 0.7 : 0.5);
      const top = sceneTop + (sceneHeight - imageHeight) * 0.5;
      const markX = mobile ? width * 0.5 : left + imageWidth * 0.708;
      const markY = top + imageHeight * 0.46;
      const markWidth = Math.min(imageWidth * 0.335, width * (mobile ? 0.9 : 0.42));
      const values: Record<string, string> = {
        "--mark-x": `${markX}px`,
        "--mark-y": `${markY}px`,
        "--mark-width": `${markWidth}px`,
        "--shadow-x": `${mobile ? width * 0.5 : left + imageWidth * 0.708}px`,
        "--shadow-y": `${top + imageHeight * 0.829}px`,
        "--shadow-width": `${markWidth * 0.78}px`,
        "--steam-x": `${Math.min(width * 0.98, left + imageWidth * 0.943)}px`,
        "--steam-y": `${top + imageHeight * 0.66}px`,
        "--steam-width": `${Math.min(imageWidth * 0.22, width * 0.5)}px`,
      };
      for (const [key, value] of Object.entries(values)) root.style.setProperty(key, value);
      x = Math.min(width * 0.985, left + imageWidth * 0.958);
      y = top + imageHeight * 0.66;
      unit = imageHeight / 520;
      root.style.setProperty("--arc-x", `${x}px`);
      root.style.setProperty("--arc-y", `${y}px`);
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      surface.width = Math.round(width * ratio);
      surface.height = Math.round(height * ratio);
      context?.setTransform(ratio, 0, 0, ratio, 0, 0);
      root.dataset["ready"] = photo.complete && photo.naturalWidth ? "true" : "false";
    };
    const observer = new ResizeObserver(resize);
    const intersection = new IntersectionObserver(
      (entries) => {
        visible = entries[0]?.isIntersecting ?? false;
        sync();
      },
      { threshold: 0.02 },
    );
    observer.observe(root);
    intersection.observe(root);
    photo.addEventListener("load", resize);
    document.addEventListener("visibilitychange", sync);
    reduced.addEventListener("change", sync);
    pause.current = (value) => {
      stopped = value;
      sync();
    };
    resize();
    sync();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      intersection.disconnect();
      photo.removeEventListener("load", resize);
      document.removeEventListener("visibilitychange", sync);
      reduced.removeEventListener("change", sync);
      pause.current = null;
    };
  }, []);

  useEffect(() => {
    pause.current?.(paused);
  }, [paused]);

  return (
    <div
      ref={host}
      className="living-photo"
      data-motion="playing"
      aria-label="Мастер Сварщик: логотип парит над рабочим столом, летят искры и поднимается дым"
    >
      <img src={plate} alt="" aria-hidden="true" className="living-ambient" />
      <img
        ref={image}
        src={plate}
        alt=""
        aria-hidden="true"
        className="living-background"
        fetchPriority="high"
      />
      <div className="living-reflections" aria-hidden="true" />
      <div className="living-shadow" aria-hidden="true" />
      <img src={fume} alt="" aria-hidden="true" className="living-vapor living-vapor-a" />
      <img src={fume} alt="" aria-hidden="true" className="living-vapor living-vapor-b" />
      <canvas ref={canvas} className="living-sparks" aria-hidden="true" />
      <div className="living-arc" aria-hidden="true" />
      <div className="living-mark" aria-hidden="true">
        <img src={mark} alt="" />
      </div>
      <div className="living-readability" aria-hidden="true" />
      <button
        type="button"
        className="living-pause"
        aria-pressed={paused}
        aria-label={paused ? "Продолжить живую фотографию" : "Приостановить живую фотографию"}
        onClick={() => {
          const next = !paused;
          pause.current?.(next);
          setPaused(next);
        }}
      >
        {paused ? <Play size={13} /> : <Pause size={13} />}
        <span>{paused ? "Продолжить" : "Пауза"}</span>
      </button>
    </div>
  );
}
