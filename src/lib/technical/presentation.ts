import type { PublicTechnicalCard } from "./schema";
import { technicalOptionLabel } from "./options";

export type TechnicalValue = PublicTechnicalCard["values"][number];
export const processLabels: Record<TechnicalValue["process"], string> = {
  general: "Общие параметры",
  mma: "MMA · Ручная дуговая сварка",
  mig: "MIG/MAG · Полуавтоматическая сварка",
  tig: "TIG · Аргонодуговая сварка",
  cut: "CUT · Плазменная резка",
  fcaw: "FCAW · Порошковая проволока",
};
const number = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 20 });
export const formatTechnicalNumber = (value: number) => number.format(value);
export function formatTechnicalDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${day}.${month}.${year}`;
}
export function formatTechnicalValue(fact: TechnicalValue): string {
  if (fact.state === "unknown") return "Не указано";
  if (fact.state === "not_applicable") return "Не применяется";
  const scalar = (value: string | number | boolean) =>
    typeof value === "boolean"
      ? value
        ? "Да"
        : "Нет"
      : typeof value === "number"
        ? number.format(value)
        : technicalOptionLabel(fact.code, value);
  const value = Array.isArray(fact.value)
    ? fact.value.map(scalar).join("; ")
    : fact.value === null
      ? "Не указано"
      : scalar(fact.value);
  if (fact.unit.code === "size_number") return `№ ${value}`;
  return fact.unit.code === "none" ? value : `${value} ${fact.unit.label}`;
}
export function formatTechnicalContext(context: TechnicalValue["context"]): string[] {
  const parts: string[] = [];
  if (context.current_a !== undefined) parts.push(`Ток: ${number.format(context.current_a)} А`);
  if (context.temperature_c !== undefined)
    parts.push(`Температура: ${number.format(context.temperature_c)} °C`);
  if (context.pressure_bar !== undefined)
    parts.push(`Давление: ${number.format(context.pressure_bar)} бар`);
  if (context.gas !== undefined) parts.push(`Газ: ${context.gas}`);
  if (context.cooling !== undefined)
    parts.push(`Охлаждение: ${context.cooling === "air" ? "воздушное" : "жидкостное"}`);
  if (context.duty_pct !== undefined)
    parts.push(`Продолжительность нагрузки: ${number.format(context.duty_pct)} %`);
  if (context.material !== undefined) parts.push(`Материал: ${context.material}`);
  if (context.diameter_mm !== undefined)
    parts.push(`Диаметр: ${number.format(context.diameter_mm)} мм`);
  return parts;
}
export function groupTechnicalValues(values: TechnicalValue[]) {
  return (Object.keys(processLabels) as TechnicalValue["process"][])
    .map((process) => ({
      process,
      label: processLabels[process],
      values: values.filter((v) => v.process === process),
    }))
    .filter((group) => group.values.length > 0);
}
