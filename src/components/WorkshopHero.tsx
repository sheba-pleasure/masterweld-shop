import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pause, Play, Search } from "lucide-react";
import originalLogo from "@/assets/brand/master_svarshchik_3d_256px.png";
import workshop from "@/assets/brand/workshop-panorama.webp";
import { ArcTelemetryCanvas } from "@/components/ArcTelemetryCanvas";
import type { WorkshopController } from "@/components/workshop/scene";

export function WorkshopHero({
  search,
  onSearch,
  children,
}: {
  search: string;
  onSearch: (value: string) => void;
  children?: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<WorkshopController | null>(null);
  const [paused, setPaused] = useState(false);
  const [sceneState, setSceneState] = useState("poster");

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let generation = 0;
    let instance: WorkshopController | undefined;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const stop = () => {
      generation++;
      instance?.dispose();
      instance = undefined;
      controller.current = null;
      setSceneState("poster");
    };
    const start = async () => {
      const attempt = ++generation;
      if (reduced.matches || disposed) return;
      try {
        const { mountWorkshopScene } = await import("@/components/workshop/scene");
        if (disposed || reduced.matches || attempt !== generation) return;
        instance = mountWorkshopScene(element, {
          logo: originalLogo,
          onReady: () => {
            if (!disposed) setSceneState("live");
          },
          onFailure: () => {
            if (!disposed) setSceneState("fallback");
          },
        });
        controller.current = instance;
      } catch {
        if (!disposed) setSceneState("fallback");
      }
    };
    const change = () => {
      stop();
      void start();
    };
    void start();
    reduced.addEventListener("change", change);
    return () => {
      disposed = true;
      reduced.removeEventListener("change", change);
      instance?.dispose();
      controller.current = null;
    };
  }, []);

  useEffect(() => {
    controller.current?.setPaused(paused);
  }, [paused, sceneState]);

  return (
    <>
      <section
        className="workshop-hero"
        aria-labelledby="workshop-title"
        data-scene-state={sceneState}
      >
        <div className="workshop-stage">
          <img
            src={workshop}
            alt=""
            aria-hidden="true"
            className="workshop-panorama"
            fetchPriority="high"
          />
          <div className="workshop-stage-shade" />
          <img src={originalLogo} alt="" aria-hidden="true" className="workshop-logo-poster" />
          <div ref={host} className="workshop-webgl" aria-hidden="true" />
          <button
            type="button"
            className="workshop-motion"
            aria-label={paused ? "Включить анимацию цеха" : "Остановить анимацию цеха"}
            aria-pressed={paused}
            onClick={() => setPaused((value) => !value)}
          >
            {paused ? <Play size={13} /> : <Pause size={13} />}
            <span>{paused ? "Продолжить" : "Пауза"}</span>
          </button>
        </div>

        <div className="workshop-copy">
          <p className="workshop-caption">Мастер Сварщик · Москва</p>
          <h1 id="workshop-title">
            Всё для сварки —<br />
            высшей марки.
          </h1>
          <p className="workshop-intro">
            Оборудование, расходники и подбор
            <br className="hidden sm:block" /> под вашу задачу.
          </p>
          <a href="#catalog" className="workshop-catalog-link">
            Перейти в каталог <span aria-hidden="true">↗</span>
          </a>
          <div className="workshop-search">
            <Search size={18} aria-hidden="true" />
            <input
              type="search"
              value={search}
              onChange={(event) => onSearch(event.target.value)}
              placeholder="Модель, артикул или бренд"
              aria-label="Поиск по каталогу: модель, артикул или бренд"
            />
          </div>
        </div>
      </section>

      <div className="workshop-instruments">
        <div className="workshop-categories">
          <p>Сварочные аппараты и всё, что нужно для работы</p>
          <div className="flex flex-wrap gap-2">{children}</div>
        </div>
        <div className="workshop-oscilloscope">
          <ArcTelemetryCanvas compact paused={paused} />
        </div>
      </div>
    </>
  );
}
