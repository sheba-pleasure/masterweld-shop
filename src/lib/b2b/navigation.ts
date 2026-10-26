import { z } from "zod";

export const LEADS_PAGE_SIZE = 6;
export const MAX_LEADS_PAGE = 1000;
export const LEAD_COLUMNS = "id,stage,priority,created_at,needs_review";
export const LEAD_ORDER = ["created_at", "id"] as const;
export const B2B_READ_ERROR =
  "Не удалось открыть B2B. Этап может быть не активирован; повторите позже.";
export const B2B_DENIED = "B2B доступен только в личном чате сотрудникам с соответствующим правом.";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validLeadId(value: unknown): value is string {
  return typeof value === "string" && uuid.test(value);
}
export function parseLeadsPage(value: unknown = "1"): number | null {
  if (typeof value !== "string" || !/^[1-9]\d{0,3}$/.test(value)) return null;
  const page = Number(value);
  return page <= MAX_LEADS_PAGE ? page : null;
}
export function leadsRange(page: number) {
  if (!Number.isInteger(page) || parseLeadsPage(String(page)) === null) return null;
  const start = (page - 1) * LEADS_PAGE_SIZE;
  // One bounded lookahead row, not a total count or an unbounded download.
  return { start, end: start + LEADS_PAGE_SIZE };
}
export type B2BRequest =
  { kind: "list"; page: number } | { kind: "lead"; id: string; page: number };
export function parseB2BCommand(command: string, args: string[]): B2BRequest | null {
  if (command === "/leads" && args.length <= 1) {
    const page = parseLeadsPage(args[0]);
    return page === null ? null : { kind: "list", page };
  }
  if (command === "/lead" && args.length === 1 && validLeadId(args[0]))
    return { kind: "lead", id: args[0].toLowerCase(), page: 1 };
  return null;
}
export function parseB2BCallback(value: unknown): B2BRequest | null {
  if (typeof value !== "string" || new TextEncoder().encode(value).length > 64) return null;
  const list = value.match(/^b2b:p:([1-9]\d{0,3})$/);
  if (list) {
    const page = parseLeadsPage(list[1]);
    return page === null ? null : { kind: "list", page };
  }
  const card = value.match(/^b2b:l:([0-9a-f-]{36}):([1-9]\d{0,3})$/i);
  if (!card || !validLeadId(card[1])) return null;
  const page = parseLeadsPage(card[2]);
  return page === null ? null : { kind: "lead", id: card[1].toLowerCase(), page };
}
export const safeLeadSchema = z.object({
  id: z.string().regex(uuid),
  stage: z.string().max(64),
  priority: z.string().max(64),
  created_at: z.string().datetime({ offset: true }),
  needs_review: z.boolean(),
});
export type SafeLead = z.infer<typeof safeLeadSchema>;
export type LeadCounts = { messages: number; drafts: number };
export type B2BMessage = {
  text: string;
  reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
};
const stages: Record<string, string> = {
  new: "Новая заявка",
  qualification: "Квалификация",
  first_contact: "Первый контакт",
  clarification: "Уточнения",
  supplier_search: "Поиск поставщика",
  economics: "Расчёт экономики",
  proposal: "КП",
  follow_up: "Повторный контакт",
  won: "Выиграно",
  lost: "Проиграно",
};
// Plain text only: no parse_mode. Untrusted values never interpolate into markup.
function statusText(lead: SafeLead) {
  const stage = Object.hasOwn(stages, lead.stage) ? stages[lead.stage] : "Нужна проверка";
  return `Этап: ${stage}; приоритет: ${lead.priority === "high_manual" ? "высокий ручной" : "ручной"}\nСоздана: ${new Date(lead.created_at).toISOString()}\nПроверка: ${lead.needs_review ? "нужна" : "завершена"}`;
}
export function compareLeads(a: SafeLead, b: SafeLead) {
  return Date.parse(b.created_at) - Date.parse(a.created_at) || b.id.localeCompare(a.id);
}
export function formatLeads(input: unknown, page: number): B2BMessage {
  if (!leadsRange(page)) throw new Error("INVALID_PAGE");
  const rows = z
    .array(safeLeadSchema)
    .max(LEADS_PAGE_SIZE + 1)
    .parse(input);
  const items = [...rows].sort(compareLeads).slice(0, LEADS_PAGE_SIZE);
  const keyboard = items.map((r, i) => [
    {
      text: `Открыть ${i + 1} · ${r.id.slice(0, 8)}`,
      callback_data: `b2b:l:${r.id.toLowerCase()}:${page}`,
    },
  ]);
  const navigation = [];
  if (page > 1) navigation.push({ text: "Назад", callback_data: `b2b:p:${page - 1}` });
  if (rows.length > LEADS_PAGE_SIZE && page < MAX_LEADS_PAGE)
    navigation.push({ text: "Вперёд", callback_data: `b2b:p:${page + 1}` });
  if (navigation.length) keyboard.push(navigation);
  return {
    text: `B2B · страница ${page}\n\n${items.length ? items.map((r, i) => `${i + 1}. ${r.id.slice(0, 8)}\n${statusText(r)}`).join("\n\n") : "На этой странице заявок нет."}`,
    reply_markup: { inline_keyboard: keyboard },
  };
}
export function formatLead(input: unknown, counts: LeadCounts, page: number): B2BMessage {
  if (!leadsRange(page)) throw new Error("INVALID_PAGE");
  const lead = safeLeadSchema.parse(input);
  const checked = z
    .object({
      messages: z.number().int().nonnegative().safe(),
      drafts: z.number().int().nonnegative().safe(),
    })
    .parse(counts);
  return {
    text: `B2B · ${lead.id.toLowerCase()}\n${statusText(lead)}\nСообщений в БД: ${checked.messages}\nЧерновиков DRAFT в БД: ${checked.drafts}${checked.drafts > 0 ? "\nЧерновик ожидает ручной проверки (текст не показывается)." : ""}`,
    reply_markup: { inline_keyboard: [[{ text: "К списку", callback_data: `b2b:p:${page}` }]] },
  };
}
