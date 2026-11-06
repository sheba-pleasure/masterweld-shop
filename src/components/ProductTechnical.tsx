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
        <p className="mt-3 rounded border border-border bg-accent px-3 py-2 text-sm font-semibold text-accent-foreground">
          Учебные данные — не паспорт товара. Значения вымышлены для проверки магазина.
        </p>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          Проверено по источникам {formatTechnicalDate(card.verified_on)}.
        </p>
      )}
      <p className="mt-3 text-sm text-muted-foreground">{card.family.label}</p>
      {card.values.length === 0 && (
        <p className="mt-3 text-sm">
          Параметры ещё не заполнены. Уточните их у сотрудника магазина.
        </p>
      )}
      <div className="mt-4 space-y-5">
        {groupTechnicalValues(card.values).map((group) => (
          <section key={group.process} aria-label={group.label}>
            <h3 className="border-b-2 border-primary pb-2 text-sm font-semibold text-foreground">
              {group.label}
            </h3>
            <dl className="divide-y divide-border">
              {group.values.map((fact, index) => {
                const sourceIndex = card.sources.findIndex((s) => s.key === fact.source_key);
                return (
                  <div
                    key={index}
                    className="grid gap-1 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:gap-4"
                  >
                    <dt className="min-w-0 break-words text-sm text-muted-foreground">
                      {fact.label}
                    </dt>
                    <dd className="min-w-0 break-words text-sm text-foreground">
                      <span
                        className={
                          fact.state === "known" ? "font-semibold" : "text-muted-foreground"
                        }
                      >
                        {formatTechnicalValue(fact)}
                      </span>
                      {formatTechnicalContext(fact.context).length > 0 && (
                        <ul
                          className="mt-1 space-y-0.5 text-xs leading-relaxed text-muted-foreground"
                          aria-label="Условия измерения"
                        >
                          {formatTechnicalContext(fact.context).map((part) => (
                            <li key={part}>{part}</li>
                          ))}
                        </ul>
                      )}
                      {sourceIndex >= 0 && (
                        <span className="mt-1 block text-xs text-muted-foreground">
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
        <details className="mt-5 rounded-lg border border-border bg-card px-4">
          <summary className="cursor-pointer py-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            Источники характеристик ({card.sources.length})
          </summary>
          <ol className="divide-y divide-border">
            {card.sources.map((source, index) => (
              <li key={source.key} className="min-w-0 break-words py-4 text-sm">
                <p className="font-semibold">
                  Источник {index + 1}. {source.title}
                </p>
                <p className="mt-2">
                  {source.publisher}. Модель: {source.model}.
                </p>
                <p className="mt-1 text-muted-foreground">{source.locator}</p>
                <p className="mt-1 text-xs text-muted-foreground">
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
                    className="mt-2 inline-block py-2 text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
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
        <h2 id={headingId} className="font-display text-lg font-semibold text-foreground">
          Характеристики
        </h2>
        <button
          type="button"
          onClick={() => void query.refetch()}
          disabled={query.isFetching || query.isPaused}
          className="min-h-11 rounded px-2 text-sm text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-wait disabled:text-muted-foreground disabled:no-underline"
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
        <p role="alert" className="mt-3 text-sm text-destructive">
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
        <details className="mt-4 rounded-lg border border-border px-4">
          <summary className="cursor-pointer py-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            Характеристики из прежнего описания
          </summary>
          <p className="pb-2 text-xs text-muted-foreground">
            Исходный текст сохранён. Его проверка по источникам ещё не подтверждена.
          </p>
          <ul className="divide-y divide-border pb-2">
            {legacy.map((line, index) => (
              <li key={index} className="break-words py-2 text-sm">
                {line}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
