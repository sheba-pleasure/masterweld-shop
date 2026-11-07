import { z } from "zod";
import dictionary, { attributeGuidance } from "./dictionary";
import { technicalOptionsHelp } from "./options";
import {
  EditorInputError,
  parseTechnicalContextValue,
  parseTechnicalFieldValue,
  technicalFieldDefinition,
} from "./editor";

export const sourceFactInputFields = [
  "value",
  "publisher",
  "locator",
  "current_a",
  "temperature_c",
  "pressure_bar",
  "gas",
  "cooling",
  "duty_pct",
  "material",
  "diameter_mm",
  "test_conditions",
] as const;
export const sourceFactInputField = z.enum(sourceFactInputFields);
export type SourceFactInputField = z.infer<typeof sourceFactInputField>;

const contextQuestions = {
  current_a: "При каком токе измерено значение? Укажите число в амперах (А).",
  temperature_c:
    "При какой температуре проводилось измерение? Укажите число в градусах Цельсия (°C).",
  pressure_bar: "При каком рабочем давлении получено значение? Укажите число в барах.",
  gas: "Какой защитный газ указан для этого измерения? Перенесите название и состав из документа.",
  cooling: "Какое охлаждение использовалось? Ответьте «Воздушное» или «Жидкостное».",
  duty_pct:
    "При какой продолжительности нагрузки получено значение? Укажите число от 0 до 100, в процентах.",
  material: "Для какого материала получено значение? Перенесите обозначение из документа.",
  diameter_mm: "Для какого диаметра получено значение? Укажите число в миллиметрах.",
  test_conditions:
    "Какие ещё условия указаны для этого значения? Перенесите их полностью из документа (до 500 знаков), вместе с единицами и ограничениями. Не сокращайте условия ради лимита: если текст длиннее или неясен, отмените ввод и пропустите строку.",
} as const;

// The caller must first check the saved actor, question message, revision and source.
// This parser never treats an answer as an approval or rewrites the immutable proposal.
export function parseSourceFactAnswer(
  familyCode: string,
  attributeCode: string | null,
  field: SourceFactInputField,
  raw: string,
): string | number | boolean | (string | number)[] {
  const text = raw.trim();
  if (field === "publisher" || field === "locator") {
    if (!text || Array.from(text).length > 1000)
      throw new EditorInputError("Введите от 1 до 1000 знаков. Если сведений нет, отмените ввод.");
    return text;
  }
  if (!attributeCode)
    throw new EditorInputError("Сначала выберите, какую характеристику означает эта строка.");
  technicalFieldDefinition(familyCode, attributeCode);
  if (field === "value") {
    const parsed = parseTechnicalFieldValue(familyCode, attributeCode, text);
    if (parsed === null) throw new EditorInputError("Не удалось прочитать значение.");
    return parsed;
  }
  return parseTechnicalContextValue(field, text);
}

export function sourceFactQuestion(
  familyCode: string,
  attributeCode: string | null,
  field: SourceFactInputField,
): string {
  const suffix =
    "\n\nОтветьте на это сообщение. " +
    (field === "publisher"
      ? "Организация сохранится для этого документа. Это не подтверждает характеристики."
      : "Сохранится только это поле; строку затем нужно проверить.") +
    "\n/input — продолжить ввод, /cancel — отменить вопрос. Сохранённые исправления останутся. Публикация не начнётся.";
  if (field === "publisher")
    return (
      "📎 Кто выпустил документ?\nУкажите организацию, напечатанную в документе. Не подставляйте изготовителя по названию товара." +
      suffix
    );
  if (field === "locator")
    return (
      "📍 Где проверить эту характеристику?\nУкажите страницу, таблицу или раздел оригинала. Если точное место неизвестно, отмените ввод и пропустите строку." +
      suffix
    );
  if (!attributeCode)
    throw new EditorInputError("Сначала выберите, какую характеристику означает эта строка.");
  const attribute = technicalFieldDefinition(familyCode, attributeCode);
  if (field !== "value")
    return (
      "🔎 Условия измерения\n" +
      attribute.label +
      "\n\n" +
      contextQuestions[field] +
      "\nБерите условие из документа. Если оно неизвестно, не подставляйте пример или ноль." +
      suffix
    );
  const unit = dictionary.units.find((item) => item.code === attribute.unit_code)?.label;
  const instruction = {
    number: "Введите число без единицы измерения. Десятичная запятая допустима.",
    integer: "Введите целое число без единицы измерения.",
    boolean: "Ответьте «Да» или «Нет», только если это подтверждает документ.",
    number_list:
      "Перечислите числа через точку с запятой. Например: 0,8; 1,0. Запятая внутри числа — десятичная.",
    enum_list: "Перенесите подходящие обозначения из списка через точку с запятой.",
    enum: "Перенесите одно подходящее обозначение из списка.",
    text: "Перенесите значение вместе с ограничениями из документа. Не сокращайте диапазон до одного числа.",
  }[attribute.kind];
  return (
    "✏️ Исправление значения\n" +
    attribute.label +
    "\n\n" +
    instruction +
    (attribute.unit_code !== "none"
      ? "\nЕдиница: " + unit + ". Не пересчитывайте из другой единицы."
      : "") +
    technicalOptionsHelp(attribute.code, attribute.options) +
    (attributeGuidance(attribute.code) ? "\n" + attributeGuidance(attribute.code) : "") +
    "\nЕсли значение не определено, отмените ввод и пропустите строку." +
    suffix
  );
}
