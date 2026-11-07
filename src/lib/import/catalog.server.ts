import { createHash } from "node:crypto";
import { CATALOG_TEMPLATE } from "./catalog-template";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { can, type StaffMember } from "@/lib/bot/permissions";
import { isPrivateChat } from "@/lib/bot/catalog";
import { tg, TelegramDeliveryError } from "@/lib/bot/telegram.server";
import {
  FIELDS,
  parseCatalogFile,
  normalizeCatalogFile,
  type CatalogFile,
  type Mapping,
} from "./catalog-file";
import { importError, renderImport, type ImportRequest, type ImportView } from "./catalog-view";
import { downloadCatalogDocument, type ImportDocument } from "./telegram-file.server";

const rpc = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{
  data: (ImportView & { source?: { header: string[]; rows: string[][] }; mapping: Mapping }) | null;
  error: { message: string } | null;
}>;
type Chat = { id: number; type?: string };
function allowed(m: StaffMember, chat: Chat) {
  return (
    isPrivateChat(chat, { id: m.telegram_id }) && can(m, "import_prices") && can(m, "view_costs")
  );
}
async function call(actor: number, op: string, args: Record<string, unknown> = {}) {
  const result = await rpc("bot_catalog_import", { p_actor: actor, p_op: op, ...args });
  if (result.error || !result.data || result.data.ok !== true)
    throw new Error(result.error?.message ?? "UNKNOWN_IMPORT_RESULT");
  return result.data;
}
async function deliver(
  chat: Chat,
  data: ImportView,
  messageId?: number,
  screen?: "config" | number,
) {
  const view = renderImport(data, screen);
  const body = { chat_id: chat.id, text: view.text, reply_markup: { inline_keyboard: view.rows } };
  const chars = Array.from(view.text);
  if (chars.length > 3500) {
    for (let i = 0; i < chars.length; i += 3500)
      await tg("sendMessage", {
        chat_id: chat.id,
        text: chars.slice(i, i + 3500).join(""),
        ...(i + 3500 >= chars.length ? { reply_markup: body.reply_markup } : {}),
      });
    return;
  }
  if (Number.isSafeInteger(messageId) && messageId! > 0) {
    try {
      return await tg("editMessageText", { ...body, message_id: messageId });
    } catch (error) {
      if (
        !(error instanceof TelegramDeliveryError) ||
        error.temporary ||
        !["http", "api"].includes(error.kind)
      )
        throw error;
    }
  }
  return tg("sendMessage", body);
}
export async function receiveCatalogDocument(
  m: StaffMember,
  chat: Chat,
  document: ImportDocument,
  updateId: number,
) {
  if (!allowed(m, chat))
    return tg("sendMessage", { chat_id: chat.id, text: importError("IMPORT_DENIED") });
  let result: ImportView;
  try {
    if (!Number.isSafeInteger(updateId) || updateId < 0) throw new Error("IMPORT_BAD_INPUT");
    const bytes = await downloadCatalogDocument(document);
    const parsed = parseCatalogFile(bytes);
    result = await call(m.telegram_id, "upload", {
      p_payload: {
        request_key: String(updateId),
        checksum: createHash("sha256").update(bytes).digest("hex"),
        file_name: document.file_name!.replace(/^.*[\\/]/, "").slice(0, 200),
        source: { header: parsed.header, rows: parsed.rows },
        mapping: parsed.mapping,
      },
    });
  } catch (error) {
    return tg("sendMessage", {
      chat_id: chat.id,
      text: importError(error instanceof Error ? error.message : undefined),
    });
  }
  return deliver(chat, result);
}
export async function showCatalogImport(
  m: StaffMember,
  chat: Chat,
  request: ImportRequest | null,
  messageId?: number,
) {
  if (!allowed(m, chat))
    return tg("sendMessage", { chat_id: chat.id, text: importError("IMPORT_DENIED") });
  if (!request)
    return tg("sendMessage", { chat_id: chat.id, text: importError("IMPORT_BAD_INPUT") });
  if (request.op === "template") {
    const form = new FormData();
    form.set("chat_id", String(chat.id));
    form.set("document", new Blob([CATALOG_TEMPLATE], { type: "text/csv" }), "import-template.csv");
    form.set(
      "caption",
      "Учебный CSV. Все суммы и товары вымышлены. Импорт не начинается автоматически.",
    );
    return tg("sendDocument", form);
  }
  let result: ImportView;
  try {
    const args: {
      p_id: string | undefined;
      p_page: number;
      p_revision: number | undefined;
      p_payload?: unknown;
    } = { p_id: request.id, p_page: request.page ?? 0, p_revision: request.revision };
    if (request.op === "preview") {
      const data = await call(m.telegram_id, "source", { p_id: request.id });
      if (data.revision !== request.revision) throw new Error("IMPORT_STALE");
      if (!data.source) throw new Error("IMPORT_BAD_INPUT");
      const file: CatalogFile = { ...data.source, mapping: data.mapping };
      args.p_payload = { rows: normalizeCatalogFile(file, data.decimal) };
    } else if (request.op === "map") {
      args.p_payload = { field: FIELDS[request.field!], column: request.column };
    } else if (request.op === "decimal") args.p_payload = { decimal: request.decimal };
    result = await call(
      m.telegram_id,
      ["config", "field"].includes(request.op) ? "get" : request.op,
      args,
    );
  } catch (error) {
    return tg("sendMessage", {
      chat_id: chat.id,
      text: importError(error instanceof Error ? error.message : undefined),
      ...(request.id &&
      error instanceof Error &&
      ["IMPORT_MODEL_CHANGED", "IMPORT_MODEL_PREVIEW_REQUIRED"].includes(error.message)
        ? {
            reply_markup: {
              inline_keyboard: [
                [{ text: "📥 Открыть текущий импорт", callback_data: `ci:get:${request.id}:0` }],
              ],
            },
          }
        : {}),
    });
  }
  return deliver(
    chat,
    result,
    messageId,
    request.op === "config" ? "config" : request.op === "field" ? request.field : undefined,
  );
}
