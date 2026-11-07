import { z } from "zod";
import { technicalDocument, type TechnicalDocument } from "./schema";
import { technicalFieldDefinition, families } from "./editor";
import dictionary from "./dictionary";
import {
  formatTechnicalContext,
  formatTechnicalValue,
  processLabels,
  type TechnicalValue,
} from "./presentation";

const position = z.number().int().min(0).max(127).nullable();
export const sourceFactMergePreview = z
  .object({
    version: z.literal("source-fact-merge-v1"),
    before_revision: z.string().uuid().nullable(),
    before_document: technicalDocument.nullable(),
    after_document: technicalDocument,
    changes: z
      .array(
        z
          .object({
            kind: z.enum(["added", "replaced", "retained", "removed"]),
            before_index: position,
            after_index: position,
          })
          .strict(),
      )
      .max(256),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const before = plan.before_document,
      after = plan.after_document;
    const seenBefore = new Set<number>(),
      seenAfter = new Set<number>();
    const sameFamily = before?.family_code === after.family_code;
    let valid = (before !== null) === (plan.before_revision !== null);
    const identity = (fact: TechnicalDocument["values"][number]) =>
      JSON.stringify([fact.attribute_code, fact.process, fact.context]);
    for (const doc of [before, after]) {
      if (!doc) continue;
      const keys = new Set(doc.sources.map((s) => s.key));
      valid &&= keys.size === doc.sources.length;
      valid &&= new Set(doc.values.map(identity)).size === doc.values.length;
      valid &&= doc.values.every((f) => f.source_key === null || keys.has(f.source_key));
    }
    for (const change of plan.changes) {
      const b = change.before_index,
        a = change.after_index;
      const oldFact = b !== null ? before?.values[b] : undefined;
      const newFact = a !== null ? after.values[a] : undefined;
      if (b !== null) {
        valid &&= !!oldFact && !seenBefore.has(b);
        seenBefore.add(b);
      }
      if (a !== null) {
        valid &&= !!newFact && !seenAfter.has(a);
        seenAfter.add(a);
      }
      if (change.kind === "added") {
        valid &&= b === null && !!newFact;
        if (newFact && sameFamily)
          valid &&= !before!.values.some((f) => identity(f) === identity(newFact));
      } else if (change.kind === "removed") {
        valid &&= a === null && !!oldFact && !sameFamily;
      } else {
        valid &&= !!oldFact && !!newFact && sameFamily;
        if (oldFact && newFact) {
          valid &&= identity(oldFact) === identity(newFact);
          if (change.kind === "retained") {
            valid &&= JSON.stringify(oldFact) === JSON.stringify(newFact);
            valid &&=
              JSON.stringify(before!.sources.find((s) => s.key === oldFact.source_key)) ===
              JSON.stringify(after.sources.find((s) => s.key === newFact.source_key));
          }
        }
      }
    }
    valid &&=
      seenBefore.size === (before?.values.length ?? 0) && seenAfter.size === after.values.length;
    if (!valid) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "SOURCE_FACT_MERGE_RESULT" });
  });
export type SourceFactMergePreview = z.infer<typeof sourceFactMergePreview>;

const changeLabels = {
  added: "➕ Добавится",
  replaced: "🔄 Заменится",
  retained: "✅ Останется",
  removed: "➖ Уберётся из нового черновика",
};
const familyLabel = (code: string) => families.find((f) => f.code === code)?.label ?? code;

export function sourceFactMergeSummary(plan: SourceFactMergePreview): string {
  const count = (kind: SourceFactMergePreview["changes"][number]["kind"]) =>
    plan.changes.filter((c) => c.kind === kind).length;
  const lines = [
    "Сравнение с сохранёнными характеристиками",
    "➕ Добавится: " + count("added"),
    "🔄 Заменится: " + count("replaced"),
    "✅ Останется: " + count("retained"),
    "➖ Уберётся: " + count("removed"),
  ];
  if (
    plan.before_document &&
    plan.before_document.family_code !== plan.after_document.family_code
  ) {
    lines.push(
      "",
      "⚠️ Меняется вид товара: " +
        familyLabel(plan.before_document.family_code) +
        " → " +
        familyLabel(plan.after_document.family_code) +
        ".",
      "Прежние характеристики уберутся из нового черновика. История сохранится. Проверьте каждое удаление.",
    );
  } else if (!plan.before_document) {
    lines.push("", "Сохранённого блока характеристик сейчас нет.");
  }
  lines.push(
    "",
    "Совпадение поля, режима и условий означает замену, включая источник. Другие условия — отдельное значение.",
    "Это план нового черновика. Карточка товара пока не меняется.",
  );
  return lines.join("\n");
}

function describeFact(document: TechnicalDocument, index: number): string {
  const fact = document.values[index]!;
  const a = technicalFieldDefinition(document.family_code, fact.attribute_code);
  const unit = dictionary.units.find((u) => u.code === fact.unit_code);
  if (!unit || unit.code !== a.unit_code) throw new Error("SOURCE_FACT_MERGE_RESULT");
  const lines = [
    a.label,
    processLabels[fact.process],
    formatTechnicalValue({
      ...fact,
      code: fact.attribute_code,
      label: a.label,
      kind: a.kind as TechnicalValue["kind"],
      unit,
    }),
    ...formatTechnicalContext(fact.context),
  ];
  const source = document.sources.find((s) => s.key === fact.source_key);
  if (source)
    lines.push(
      "Источник: " + source.title,
      "Издатель: " + source.publisher,
      "Модель в источнике: " + source.model,
      "Место: " + source.locator,
    );
  return lines.join("\n");
}

// One change per page: never truncate a value, list or source locator just to fit the summary.
export function sourceFactMergeDetail(plan: SourceFactMergePreview, index: number): string {
  if (!Number.isInteger(index) || index < 0 || !plan.changes[index])
    throw new Error("SOURCE_FACT_PAGE");
  const change = plan.changes[index]!;
  const parts = [changeLabels[change.kind] + " · " + (index + 1) + "/" + plan.changes.length];
  if (change.before_index !== null)
    parts.push("Сейчас:\n" + describeFact(plan.before_document!, change.before_index));
  if (change.after_index !== null)
    parts.push(
      (change.kind === "retained" ? "Останется без изменений:\n" : "В новом черновике:\n") +
        describeFact(plan.after_document, change.after_index),
    );
  else parts.push("В новом черновике этого значения не будет. Оно сохранится в истории.");
  return parts.join("\n\n");
}
