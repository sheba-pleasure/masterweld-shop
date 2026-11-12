import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { productTechnicalQuery } from "@/lib/technical/catalog";
import { productDocuments } from "@/lib/technical/documents";

export function ProductDocumentation({ productId }: { productId: string }) {
  const heading = useId();
  const query = useQuery(productTechnicalQuery(productId));
  // A failed refresh must not leave withdrawn/stale documentation visible.
  const documents = query.isError ? [] : productDocuments(query.data);
  return (
    <section aria-labelledby={heading} className="mt-10 max-w-3xl border-t border-border pt-6">
      <h2 id={heading} className="font-display text-lg font-semibold text-foreground">Документация</h2>
      {query.isPending ? (
        <p className="mt-3 text-sm text-muted-foreground">Загружаем документы…</p>
      ) : query.isError ? (
        <p className="mt-3 text-sm text-muted-foreground">Документы сейчас недоступны. Запросите их у сотрудника магазина.</p>
      ) : documents.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">Документы для этой модификации уточняются. Сотрудник поможет получить паспорт, инструкцию или документ соответствия.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {documents.map((document) => (
            <li key={document.url} className="py-4">
              <a href={document.url} target="_blank" rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center break-words text-sm font-semibold underline underline-offset-4">
                {document.title}
                <span className="sr-only"> (новая вкладка)</span>
              </a>
              <p className="mt-1 text-sm text-muted-foreground">{document.publisher}. Модель: {document.model}.</p>
              <p className="mt-1 text-xs text-muted-foreground">{document.locator}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
