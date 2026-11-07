import { z } from "zod";
import dictionary, { attributeGuidance } from "./dictionary";
import {
  technicalDocument,
  technicalFact,
  technicalSource,
  technicalContext,
  technicalProcess,
} from "./schema";
import {
  formatTechnicalContext,
  formatTechnicalValue,
  processLabels,
  type TechnicalValue,
} from "./presentation";

export class EditorInputError extends Error {}

export const editorData = z
  .object({
    document: technicalDocument.nullable(),
    screen: z.enum([
      "home",
      "families",
      "fields",
      "process",
      "facts",
      "value",
      "context",
      "sources",
      "source_kind",
      "source_input",
      "inspect",
      "cancel",
      "undo",
      "delete",
      "family_change",
    ]),
    page: z.number().int().min(0).max(128),
    field: z.string().nullable(),
    fact: z.number().int().min(0).max(127).nullable(),
    pending: technicalFact.innerType().nullable(),
    source: z.record(z.string()).nullable(),
    sourceField: z.number().int().min(0).max(6),
  })
  .strict();
export type EditorData = z.infer<typeof editorData>;
export type Fact = z.infer<typeof technicalFact>;
export const families = dictionary.families.filter((f) =>
  dictionary.bindings.some((b) => b.family_code === f.code),
);
export const sourceKinds = [
  ["manufacturer", "Изготовитель"],
  ["manual", "Паспорт / руководство"],
  ["test_report", "Протокол испытаний"],
  ["supplier", "Поставщик · на проверку"],
  ["research", "Исследование · на проверку"],
] as const;
export const sourceFields = [
  "publisher",
  "model",
  "title",
  "url",
  "locator",
  "checked_on",
] as const;
export const sourceQuestions = [
  "Кто выпустил документ? Укажите изготовителя или организацию.",
  "Точная модель и модификация из документа:",
  "Название документа:",
  "Ссылка HTTPS на документ без параметров и #. Файл должен быть доступен для проверки.",
  "Где искать сведения: страница, таблица или раздел?",
  "Дата проверки документа: ГГГГ-ММ-ДД. Например, 2026-11-06.",
];
const contextLabels: Record<string, string> = {
  current_a: "Ток, А",
  temperature_c: "Температура испытаний, °C",
  pressure_bar: "Рабочее давление, бар",
  gas: "Защитный газ",
  cooling: "Охлаждение: air — воздушное; liquid — жидкостное",
  duty_pct: "Продолжительность нагрузки, %",
  material: "Материал",
  diameter_mm: "Диаметр, мм",
};
export function technicalFieldDefinition(familyCode: string, attributeCode: string) {
  const attr = dictionary.attributes.find((a) => a.code === attributeCode);
  const binding = dictionary.bindings.find(
    (b) => b.family_code === familyCode && b.attribute_code === attributeCode,
  );
  if (!attr || !binding) throw new EditorInputError("Выберите характеристику заново.");
  return {
    ...attr,
    label: binding.label ?? attr.label,
    options: binding.options_override ?? attr.options,
  };
}
export function definition(state: EditorData) {
  return technicalFieldDefinition(state.document?.family_code ?? "", state.field ?? "");
}
export function fields(state: EditorData) {
  return dictionary.bindings.filter((b) => b.family_code === state.document?.family_code);
}
export function describeFact(fact: Fact): string {
  const attr = dictionary.attributes.find((a) => a.code === fact.attribute_code);
  if (!attr) return "Неизвестная характеристика";
  return [
    attr.label,
    processLabels[fact.process],
    formatTechnicalValue({
      ...fact,
      code: fact.attribute_code,
      label: attr.label,
      kind: attr.kind as TechnicalValue["kind"],
      unit: dictionary.units.find((u) => u.code === fact.unit_code)!,
    }),
    ...formatTechnicalContext(fact.context),
  ].join(" · ");
}
export function sourceSummary(source: z.infer<typeof technicalSource>): string {
  return [
    source.publisher,
    source.model,
    source.title,
    source.locator,
    source.checked_on,
    source.url || "SHA256: " + source.sha256,
  ].join("\n");
}
export function missingContext(state: EditorData) {
  const attr = definition(state);
  return attr.required_context.find(
    (k) => state.pending?.context[k as keyof Fact["context"]] === undefined,
  );
}
function numeric(text: string) {
  if (!/^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(text))
    throw new EditorInputError(
      "Введите число без единицы измерения. Десятичная запятая допустима.",
    );
  const value = Number(text.replace(",", "."));
  if (!Number.isFinite(value) || Math.abs(value) > 1e9)
    throw new EditorInputError("Число вне допустимого диапазона.");
  return value;
}
export function parseTechnicalFieldValue(
  familyCode: string,
  attributeCode: string,
  raw: string,
): Fact["value"] {
  const text = raw.trim();
  const a = technicalFieldDefinition(familyCode, attributeCode);
  const number = (s: string) => {
    const n = numeric(s);
    if (
      (a.minimum !== null && n < a.minimum) ||
      (a.maximum !== null && n > a.maximum) ||
      (a.kind === "integer" && !Number.isInteger(n))
    )
      throw new EditorInputError("Значение вне допустимого диапазона характеристики.");
    return n;
  };
  if (a.kind === "number" || a.kind === "integer") return number(text);
  if (a.kind === "boolean") {
    if (/^(да|true)$/i.test(text)) return true;
    if (/^(нет|false)$/i.test(text)) return false;
    throw new EditorInputError(
      "Ответьте «да» или «нет». Неизвестное значение выбирается отдельной кнопкой.",
    );
  }
  if (a.kind === "number_list" || a.kind === "enum_list") {
    const items = text.split(";").map((s) => s.trim());
    if (!items.length || items.length > 32 || items.some((s) => !s))
      throw new EditorInputError("Укажите от 1 до 32 значений через точку с запятой.");
    const result = a.kind === "number_list" ? items.map(number) : items;
    if (new Set<string | number>(result).size !== result.length)
      throw new EditorInputError("Уберите повторяющиеся значения.");
    if (a.kind === "enum_list" && items.some((s) => !a.options.includes(s)))
      throw new EditorInputError("Выберите коды из предложенного списка.");
    return result;
  }
  if (a.kind === "enum" && !a.options.includes(text))
    throw new EditorInputError("Выберите код из предложенного списка.");
  if (!text || text.length > 500) throw new EditorInputError("Введите от 1 до 500 символов.");
  return text;
}
export function parseTechnicalContextValue(key: keyof Fact["context"], raw: string) {
  const text = raw.trim();
  const value = ["gas", "cooling", "material"].includes(key) ? text : numeric(text);
  const parsed = technicalContext.safeParse({ [key]: value });
  if (!parsed.success || (typeof value === "number" && value > 1000000))
    throw new EditorInputError("Проверьте значение условия и указанную единицу измерения.");
  return parsed.data[key]!;
}
function nextAfterValue(s: EditorData) {
  s.screen = missingContext(s) ? "context" : "sources";
}
function commitFact(s: EditorData) {
  if (!s.document || !s.pending) throw new EditorInputError("Сначала выберите характеристику.");
  const fact = technicalFact.parse(s.pending);
  if (
    s.document.values.some(
      (v, i) =>
        i !== s.fact &&
        v.attribute_code === fact.attribute_code &&
        v.process === fact.process &&
        JSON.stringify(Object.entries(v.context).sort()) ===
          JSON.stringify(Object.entries(fact.context).sort()),
    )
  )
    throw new EditorInputError(
      "Такая характеристика с этими условиями уже есть. Откройте существующее значение.",
    );
  if (s.fact === null) {
    if (s.document.values.length >= 128)
      throw new EditorInputError("Достигнут предел 128 значений.");
    s.document.values.push(fact);
  } else s.document.values[s.fact] = fact;
  s.pending = null;
  s.fact = null;
  s.screen = "home";
  s.page = 0;
  // Only sources still referenced by a fact are submitted for review.
  const used = new Set(s.document.values.map((v) => v.source_key));
  s.document.sources = s.document.sources.filter((v) => used.has(v.key));
}
export function editorReply(input: EditorData, raw: string): EditorData {
  const s = structuredClone(input),
    text = raw.trim();
  if (s.screen === "value" && s.pending) {
    s.pending.value = parseTechnicalFieldValue(s.document?.family_code ?? "", s.field ?? "", text);
    s.pending.state = "known";
    nextAfterValue(s);
  } else if (s.screen === "context" && s.pending) {
    const key = missingContext(s);
    if (!key) throw new EditorInputError("Условия уже заполнены.");
    const value = parseTechnicalContextValue(key as keyof Fact["context"], text);
    const parsed = technicalContext.safeParse({ ...s.pending.context, [key]: value });
    if (!parsed.success)
      throw new EditorInputError("Проверьте значение условия и указанную единицу измерения.");
    s.pending.context = parsed.data;
    nextAfterValue(s);
  } else if (s.screen === "source_input" && s.source) {
    const key = sourceFields[s.sourceField];
    if (!key || !text || text.length > 1000)
      throw new EditorInputError("Введите от 1 до 1000 символов.");
    if (key === "url" && !/^https:\/\/[a-zA-Z0-9.-]+\/[^?#@\s]*$/.test(text))
      throw new EditorInputError("Нужна ссылка HTTPS без параметров, # и пароля.");
    if (
      key === "checked_on" &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(text) ||
        !Number.isFinite(Date.parse(text)) ||
        new Date(text).toISOString().slice(0, 10) !== text ||
        text > new Date().toISOString().slice(0, 10))
    )
      throw new EditorInputError("Нужна существующая дата не позднее сегодняшней.");
    s.source[key] = text;
    if (s.sourceField < sourceFields.length - 1) s.sourceField++;
    else {
      if (!s.document || !s.pending || s.document.sources.length >= 32)
        throw new EditorInputError("Нельзя добавить источник.");
      const source = technicalSource.parse(s.source);
      s.document.sources.push(source);
      s.pending.source_key = source.key;
      commitFact(s);
      s.source = null;
      s.sourceField = 0;
    }
  } else throw new EditorInputError("Этот ответ уже не ожидается. Откройте /technical.");
  return editorData.parse(s);
}
/** State transitions are pure. SQL persists the complete result with revision compare-and-swap. */
export function editorAction(input: EditorData, action: string, index = 0): EditorData {
  const s = structuredClone(input);
  if (!Number.isSafeInteger(index) || index < 0 || index > 128)
    throw new EditorInputError("Недействительная кнопка.");
  if (action === "home") {
    s.screen = "home";
    s.pending = null;
    s.fact = null;
    s.page = 0;
  } else if (action === "families" && ["home", "families"].includes(s.screen)) {
    if (index * 8 >= families.length) throw new EditorInputError("Страница не найдена.");
    s.screen = "families";
    s.page = index;
  } else if (action === "family" && s.screen === "families") {
    const family = families[index];
    if (!family) throw new EditorInputError("Семейство не найдено.");
    if (s.document && s.document.family_code !== family.code && s.document.values.length) {
      s.screen = "family_change";
      s.page = index;
    } else {
      if (s.document?.family_code !== family.code)
        s.document = { family_code: family.code, sources: [], values: [] };
      s.screen = "home";
      s.page = 0;
    }
  } else if (action === "family_yes" && s.screen === "family_change") {
    const family = families[s.page];
    if (!family) throw new EditorInputError("Семейство не найдено.");
    s.document = { family_code: family.code, sources: [], values: [] };
    s.screen = "home";
    s.page = 0;
  } else if (action === "fields" && s.document) {
    s.screen = "fields";
    s.page = index;
  } else if (action === "field" && s.screen === "fields") {
    const field = fields(s)[index];
    if (!field) throw new EditorInputError("Характеристика не найдена.");
    s.field = field.attribute_code;
    s.screen = "process";
  } else if (action === "process" && s.screen === "process") {
    const attr = definition(s),
      process = technicalProcess.parse(attr.processes[index]);
    s.pending = {
      attribute_code: attr.code,
      process,
      state: "unknown",
      value: null,
      unit_code: attr.unit_code,
      context: {},
      source_key: null,
    };
    s.screen = "facts";
    s.page = 0;
  } else if (action === "factpage" && s.screen === "facts") {
    s.page = index;
  } else if (action === "new" && s.screen === "facts" && s.pending) {
    s.fact = null;
    s.pending.context = technicalContext.parse(definition(s).fixed_context);
    s.screen = "value";
  } else if (action === "existing" && s.screen === "facts" && s.document && s.pending) {
    const fact = s.document.values[index];
    if (!fact || fact.attribute_code !== s.field || fact.process !== s.pending.process)
      throw new EditorInputError("Значение не найдено.");
    s.fact = index;
    s.pending = structuredClone(fact);
    s.screen = "value";
  } else if (action === "unknown" && s.screen === "value" && s.pending) {
    s.pending = { ...s.pending, state: "unknown", value: null, source_key: null, context: {} };
    delete s.pending.origin_ref;
    commitFact(s);
  } else if (action === "na" && s.screen === "value" && s.pending) {
    s.pending = {
      ...s.pending,
      state: "not_applicable",
      value: null,
      source_key: null,
      context: {},
    };
    delete s.pending.origin_ref;
    commitFact(s);
  } else if (
    action === "conditions" &&
    s.screen === "value" &&
    s.pending &&
    s.pending.state === "known"
  ) {
    s.pending.context = technicalContext.parse(definition(s).fixed_context);
    nextAfterValue(s);
  } else if (action === "source" && s.screen === "sources" && s.pending && s.document) {
    const source = s.document.sources[index];
    if (!source) throw new EditorInputError("Источник не найден.");
    s.pending.source_key = source.key;
    commitFact(s);
  } else if (action === "newsource" && s.screen === "sources") s.screen = "source_kind";
  else if (action === "kind" && s.screen === "source_kind") {
    const kind = sourceKinds[index];
    if (!kind) throw new EditorInputError("Вид источника не найден.");
    let n = 0;
    while (s.document?.sources.some((v) => v.key === "source_" + n)) n++;
    s.source = { key: "source_" + n, kind: kind[0], sha256: "" };
    s.sourceField = 0;
    s.screen = "source_input";
  } else if (action === "inspect" && s.document) {
    s.screen = "inspect";
    s.page = index;
  } else if (action === "delete" && s.screen === "value" && s.fact !== null) s.screen = "delete";
  else if (action === "delete_yes" && s.screen === "delete" && s.document && s.fact !== null) {
    s.document.values.splice(s.fact, 1);
    s.screen = "home";
    s.fact = null;
    s.pending = null;
    const used = new Set(s.document.values.map((v) => v.source_key));
    s.document.sources = s.document.sources.filter((v) => used.has(v.key));
  } else if (action === "cancel") s.screen = "cancel";
  else if (action === "undo") s.screen = "undo";
  else throw new EditorInputError("Кнопка устарела. Откройте /technical.");
  return editorData.parse(s);
}
export function editorQuestion(s: EditorData): string | null {
  if (s.screen === "value") {
    const a = definition(s),
      unit = dictionary.units.find((u) => u.code === a.unit_code)?.label;
    return (
      "✏️ " +
      a.label +
      " · " +
      processLabels[s.pending!.process] +
      "\n" +
      (s.fact !== null && s.pending ? "Сейчас: " + describeFact(s.pending) + "\n" : "") +
      (a.kind === "boolean"
        ? "Ответьте «да» или «нет»."
        : a.kind === "number_list"
          ? "Значения через точку с запятой (например: 0,8; 1,0)."
          : a.kind === "enum_list"
            ? "Коды из списка через точку с запятой."
            : "Введите значение.") +
      (a.unit_code !== "none"
        ? "\nЕдиница: " + unit + ". Не пересчитывайте из другой единицы."
        : "") +
      (a.options.length ? "\nДопустимые коды: " + a.options.join("; ") : "") +
      (attributeGuidance(a.code) ? "\n\n" + attributeGuidance(a.code) : "")
    );
  }
  if (s.screen === "context")
    return "🔎 Условия измерения\n" + contextLabels[missingContext(s)!] + ":";
  if (s.screen === "source_input")
    return "📎 Источник · " + (s.sourceField + 1) + "/6\n" + sourceQuestions[s.sourceField];
  return null;
}
