import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { can, type StaffMember } from "@/lib/bot/permissions";
import { isPrivateChat } from "@/lib/bot/catalog";
import { tg } from "@/lib/bot/telegram.server";
import { downloadIntakeDocument, type ImportDocument } from "./telegram-file.server";
import { renderImport, type ImportView } from "./catalog-view";
import { renderIntake, type IntakeView, parseIntakeCallback } from "./intake-view";

const rpc = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ data: IntakeView | null; error: unknown }>;
type Chat = { id: number; type?: string };
function allowed(m: StaffMember, chat: Chat) {
  return (
    isPrivateChat(chat, { id: m.telegram_id }) && can(m, "import_prices") && can(m, "view_costs")
  );
}
async function deliver(chat: Chat, result: IntakeView, page = 0) {
  const view = renderIntake(result, page);
  return tg("sendMessage", {
    chat_id: chat.id,
    text: view.text,
    reply_markup: { inline_keyboard: view.rows },
  });
}
export async function receiveIntakeDocument(m: StaffMember, chat: Chat, document: ImportDocument) {
  if (!allowed(m, chat)) return;
  let result: IntakeView;
  try {
    const bytes = await downloadIntakeDocument(document);
    const r = await rpc("bot_document_intake", {
      p_actor: m.telegram_id,
      p_op: "upload",
      p_payload: {
        file_name: document.file_name!.replace(/^.*[\\/]/, ""),
        base64: Buffer.from(bytes).toString("base64"),
      },
    });
    if (r.error || !r.data?.ok) throw new Error("DOCUMENT_STORE");
    result = r.data;
  } catch {
    return tg("sendMessage", {
      chat_id: chat.id,
      text: "⚠️ Файл не принят или результат приёма неизвестен. Проверьте /documents. Можно повторно отправить тот же файл: копия с тем же содержимым вернёт прежнюю обработку. Лимит — 5 МБ, до пяти ожидающих файлов.",
    });
  }
  return deliver(chat, result);
}
export async function showIntake(m: StaffMember, chat: Chat, data = "di:home") {
  if (!allowed(m, chat))
    return tg("sendMessage", {
      chat_id: chat.id,
      text: "🔒 Документы поставщиков доступны администратору: внутри могут быть закупочные цены.",
    });
  const request = parseIntakeCallback(data);
  if (!request) return;
  let result: IntakeView;
  try {
    const r = await rpc("bot_document_intake", {
      p_actor: m.telegram_id,
      p_op: request.op,
      p_id: request.id,
      p_payload: request.index === undefined ? {} : { index: request.index },
    });
    if (r.error || !r.data?.ok) throw new Error("DOCUMENT_READ");
    result = r.data;
  } catch {
    return tg("sendMessage", {
      chat_id: chat.id,
      text: "⚠️ Не удалось прочитать результат. Откройте /documents; не начинайте новый импорт для восстановления старого.",
    });
  }
  if (request.op === "table") {
    const view = renderImport(result as unknown as ImportView);
    return tg("sendMessage", {
      chat_id: chat.id,
      text: view.text,
      reply_markup: { inline_keyboard: view.rows },
    });
  }
  if (request.op === "original" && result.original_base64) {
    const form = new FormData();
    form.set("chat_id", String(chat.id));
    form.set(
      "document",
      new Blob([Buffer.from(result.original_base64, "base64")]),
      result.file_name ?? "original.bin",
    );
    form.set("caption", "📎 Неизменённый исходный файл. SHA-256: " + result.checksum);
    return tg("sendDocument", form);
  }
  if (request.op === "text") {
    const form = new FormData();
    form.set("chat_id", String(chat.id));
    form.set(
      "document",
      new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }),
      "document-extraction.json",
    );
    form.set(
      "caption",
      "📋 Извлечение с исходными строками и ссылками на листы/страницы. Это предложения для проверки, не подтверждённые характеристики товара.",
    );
    return tg("sendDocument", form);
  }
  return deliver(chat, result, request.page);
}
export async function enrollSellers(m: StaffMember, chat: Chat, args: string[], requestId: string) {
  if (!isPrivateChat(chat, { id: m.telegram_id }) || !can(m, "manage_staff"))
    return tg("sendMessage", {
      chat_id: chat.id,
      text: "🔒 Управление сотрудниками доступно администратору.",
    });
  if (
    !args.length ||
    args.length > 50 ||
    args.some((v) => !/^\d{1,16}$/.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) <= 0)
  )
    return tg("sendMessage", {
      chat_id: chat.id,
      text: "Добавление продавцов: /sellers ID ID. Только известные вам числовые Telegram ID. Закупка, цены и управление доступом продавцам недоступны.",
    });
  const r = await rpc("bot_enroll_sellers", {
    p_actor: m.telegram_id,
    p_request_key: requestId,
    p_ids: args.map(Number),
  });
  return tg("sendMessage", {
    chat_id: chat.id,
    text:
      r.error || !r.data?.ok
        ? "⚠️ Результат добавления требует проверки. Откройте «Сотрудники». Существующие другие роли и отключённые записи автоматически не меняются."
        : "✅ Продавцы добавлены. Права одинаковые: товары, фото, наличие и заказы. Без закупочных цен, изменения цен и управления доступом. Для уведомлений каждый должен запустить этого бота.",
  });
}
