import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { productTechnicalQuery } from "@/lib/technical/catalog";
import type { PublicTechnicalCard } from "@/lib/technical/schema";
import {
  formatTechnicalContext,
  formatTechnicalDate,
  formatTechnicalValue,
  groupTechnicalValues,
} from "@/lib/technical/presentation";

function VerifiedTechnical({ card }: { card: PublicTechnicalCard }) {
  const synthetic = card.sources.some((source) => source.kind === "synthetic");
  return (
    <>
      {synthetic ? (
        <p className="mt-3 rounded-xl border border-mw-amber/35 bg-mw-amber/10 px-4 py-3 text-sm font-semibold text-white">
          Учебные данные — не паспорт товара. Значения вымышлены для проверки магазина.
        </p>
      ) : (
        <p className="mt-2 font-mono text-xs text-muted-foreground">
          Проверено по источникам {formatTechnicalDate(card.verified_on)}.
        </p>
      )}
      <p className="mt-3 text-sm text-secondary-foreground">{card.family.label}</p>
      {card.values.length === 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          Параметры ещё не заполнены. Уточните их у сотрудника магазина.
        </p>
      )}
      <div className="mt-4 space-y-4">
        {groupTechnicalValues(card.values).map((group) => (
          <section
            key={group.process}
            aria-label={group.label}
            className="glass-panel overflow-hidden rounded-xl p-4"
          >
            <h3 className="border-b border-white/10 pb-3 text-sm font-semibold text-white">
              {group.label}
            </h3>
            <dl className="divide-y divide-white/8">
              {group.values.map((fact, index) => {
                const sourceIndex = card.sources.findIndex((s) => s.key === fact.source_key);
                return (
                  <div
                    key={index}
                    className="grid gap-1 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:gap-4"
                  >
                    <dt className="min-w-0 break-words text-sm text-muted-foreground">
                      {fact.label.startsWith("ПН ")
                        ? `Продолжительность нагрузки${fact.label.slice(2)}`
                        : fact.label}
                    </dt>
                    <dd className="min-w-0 break-words text-sm text-foreground">
                      <span
                        className={
                          fact.state === "known"
                            ? "font-mono font-semibold text-white tabular-nums"
                            : "text-muted-foreground"
                        }
                      >
                        {formatTechnicalValue(fact)}
                      </span>
                      {formatTechnicalContext(fact.context).length > 0 && (
                        <ul
                          className="mt-1 space-y-0.5 font-mono text-xs leading-relaxed text-muted-foreground"
                          aria-label="Условия измерения"
                        >
                          {formatTechnicalContext(fact.context).map((part) => (
                            <li key={part}>{part}</li>
                          ))}
                        </ul>
                      )}
                      {sourceIndex >= 0 && (
                        <span className="mt-1 block font-mono text-xs text-muted-foreground">
                          Источник {sourceIndex + 1}
                        </span>
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </section>
        ))}
      </div>
      {card.sources.length > 0 && (
        <details className="glass-panel mt-4 rounded-xl px-4">
          <summary className="cursor-pointer py-3 text-sm font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            Источники характеристик ({card.sources.length})
          </summary>
          <ol className="divide-y divide-white/10">
            {card.sources.map((source, index) => (
              <li key={source.key} className="min-w-0 break-words py-4 text-sm">
                <p className="font-semibold text-white">
                  Источник {index + 1}. {source.title}
                </p>
                <p className="mt-2 text-secondary-foreground">
                  {source.publisher}. Модель: {source.model}.
                </p>
                <p className="mt-1 text-muted-foreground">{source.locator}</p>
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  Источник проверен {formatTechnicalDate(source.checked_on)}
                </p>
                {source.kind === "synthetic" ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Учебный источник. Реального паспорта здесь нет.
                  </p>
                ) : source.url ? (
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-block py-2 text-mw-cyan underline underline-offset-4 transition-colors duration-150 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    Открыть источник (новая вкладка)
                  </a>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Открытой ссылки нет. Запросите документ у сотрудника магазина.
                  </p>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}
    </>
  );
}

export function ProductTechnical({
  productId,
  legacySpecs,
}: {
  productId: string;
  legacySpecs: string | null;
}) {
  const headingId = useId();
  const query = useQuery(productTechnicalQuery(productId));
  // A failed refresh must not leave an old verified snapshot looking current.
  const card = !query.isError && !query.isFetching && !query.isPaused ? query.data : undefined;
  const legacy = legacySpecs?.split("\n").filter((line) => line.trim()) ?? [];
  return (
    <section aria-labelledby={headingId} className="mt-8 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 id={headingId} className="font-display text-lg font-semibold text-white">
          Характеристики
        </h2>
        <button
          type="button"
          onClick={() => void query.refetch()}
          disabled={query.isFetching || query.isPaused}
          className="min-h-10 text-sm font-medium text-mw-cyan underline underline-offset-4 transition-colors duration-150 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-wait disabled:text-muted-foreground disabled:no-underline"
        >
          {query.isFetching ? "Обновляем…" : "Обновить характеристики"}
        </button>
      </div>
      {query.isPaused ? (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          Нет соединения. Характеристики обновятся после подключения.
        </p>
      ) : query.isFetching || query.isPending ? (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          Загружаем проверенные характеристики…
        </p>
      ) : query.isError ? (
        <p
          role="alert"
          className="mt-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-foreground"
        >
          Не удалось загрузить характеристики. Нажмите «Обновить характеристики» или уточните
          параметры у магазина.
        </p>
      ) : card ? (
        <VerifiedTechnical key={card.revision_id} card={card} />
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          Проверенные характеристики пока не добавлены. Уточните нужные параметры у сотрудника
          магазина.
        </p>
      )}
      {legacy.length > 0 && (
        <details className="glass-panel mt-4 rounded-xl px-4">
          <summary className="cursor-pointer py-3 text-sm font-medium text-secondary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            Характеристики из прежнего описания
          </summary>
          <p className="pb-2 text-xs text-muted-foreground">
            Исходный текст сохранён. Его проверка по источникам ещё не подтверждена.
          </p>
          <ul className="divide-y divide-white/8 pb-2">
            {legacy.map((line, index) => (
              <li key={index} className="break-words py-2 font-mono text-xs text-foreground">
                {line}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
