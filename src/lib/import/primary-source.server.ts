import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { can, type StaffMember } from "@/lib/bot/permissions";
import { isPrivateChat } from "@/lib/bot/catalog";
import { tg } from "@/lib/bot/telegram.server";
import { parseIntakeCallback, type IntakeView } from "./intake-view";
import { renderSourceBlocks, renderSourceText } from "./source-reader";
import {
  compactId,
  parseSourceCallback,
  renderSourceReview,
  sourceButton,
  sourceReviewResponse,
} from "./primary-source-view";

type Button = { text: string; callback_data: string };
type View = { text: string; rows: Button[][] };
const messages: Record<string, string> = {
  SOURCE_STALE_BUTTON:
    "Эта кнопка относится к прежнему шагу. Прочитайте сохранённый результат и продолжите оттуда.",
  SOURCE_MODEL_CHANGED:
    "Модель или её источники изменились. Отмените старый черновик, проверьте модель и начните заново.",
  SOURCE_MODEL_REQUIRED:
    "Сначала выберите точную модель товара. Затем можно проверить соответствие файла.",
  SOURCE_DRAFT_ACTIVE:
    "У вас уже есть начатая проверка документа. Откройте список документов модели и продолжите или отмените её.",
  SOURCE_INPUT_ACTIVE:
    "Сначала завершите или отмените ввод в текущем редакторе. Затем вернитесь к документам модели.",
  SOURCE_PREVIEW_EXPIRED:
    "Время подтверждения истекло. Прочитайте результат и подготовьте предпросмотр заново.",
  SOURCE_EXPIRED:
    "Этот черновик больше нельзя изменить. Откройте список документов модели и начните новую проверку.",
  SOURCE_ALREADY_CONFIRMED:
    "Этот файл уже связан с этой моделью. Отмените лишний черновик и откройте сохранённое подтверждение в списке документов.",
  SOURCE_DOCUMENT_CHANGED:
    "Выбранный документ недоступен или изменился. Прочитайте результат и выберите файл заново.",
};
export async function showProductSources(
  m: StaffMember,
  chat: { id: number; type?: string },
  data: string,
  requestId = "",
) {
  if (
    !isPrivateChat(chat, { id: m.telegram_id }) ||
    !can(m, "import_prices") ||
    !can(m, "view_costs")
  )
    return;
  const action = parseSourceCallback(data);
  if (!action) return;
  const id = action.op === "start" ? requestId : action.id;
  if (
    action.op === "start" &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId)
  ) {
    return tg("sendMessage", {
      chat_id: chat.id,
      text: "Не удалось связать проверку с этой кнопкой. Откройте документы модели заново.",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📘 Документы модели", callback_data: "pds:home:" + action.product }],
        ],
      },
    });
  }
  const rpc = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>;
  let view: View;
  try {
    const result = await rpc("bot_product_sources", {
      p_actor: m.telegram_id,
      p_op: action.op,
      p_product: action.product ?? null,
      p_id: id ?? null,
      p_revision: action.revision ?? null,
      p_payload: action.payload ?? {},
    });
    if (result.error) {
      const code =
        typeof result.error === "object" && result.error !== null && "message" in result.error
          ? String(result.error.message)
          : "";
      throw new Error(Object.hasOwn(messages, code) ? code : "SOURCE_RESULT");
    }
    const v = sourceReviewResponse.parse(result.data);
    if (
      (id && v.review?.id !== id) ||
      (action.product && v.product_id !== action.product) ||
      (v.review && v.review.product_id !== v.product_id)
    )
      throw new Error("SOURCE_RESULT");
    view = renderSourceReview(v);
    if (action.view) {
      const r = v.review;
      if (!r || r.revision !== action.revision) throw new Error("SOURCE_STALE_BUTTON");
      if (!r.document) throw new Error("SOURCE_DOCUMENT_CHANGED");
      const raw = await rpc("bot_document_intake", {
        p_actor: m.telegram_id,
        p_op: "get",
        p_id: r.document.id,
        p_payload: {},
      });
      const doc = raw.data as IntakeView | null;
      if (
        raw.error ||
        !doc?.ok ||
        doc.id !== r.document.id ||
        doc.checksum !== r.document.checksum ||
        doc.state !== "review"
      )
        throw new Error("SOURCE_DOCUMENT_CHANGED");
      const source =
        action.view === "blocks"
          ? renderSourceBlocks(doc, action.index!)
          : renderSourceText(doc, action.index!, action.part!);
      view = {
        text: source.text,
        rows: source.rows.map((row) =>
          row.map((b) => {
            const nav = parseIntakeCallback(b.callback_data);
            if (!nav || nav.id !== r.document!.id) throw new Error("SOURCE_RESULT");
            if (nav.op === "blocks")
              return { ...b, callback_data: sourceButton(r, "blocks", nav.page ?? 0) };
            if (nav.op === "read")
              return { ...b, callback_data: sourceButton(r, "read", nav.index!, nav.page ?? 0) };
            if (nav.op === "original") return b;
            if (nav.op === "get")
              return { text: "↩️ К проверке документа", callback_data: "pds:g:" + compactId(r.id) };
            throw new Error("SOURCE_RESULT");
          }),
        ),
      };
    }
  } catch (error) {
    const explanation = error instanceof Error ? messages[error.message] : undefined;
    view = {
      text:
        "⚠️ " +
        (explanation ??
          "Не удалось прочитать результат. Это не означает, что действие не сохранилось.") +
        "\n\nНажмите «Прочитать сохранённый результат». Подтверждение автоматически не повторяется.",
      rows: [
        [
          {
            text: "🔄 Прочитать сохранённый результат",
            callback_data: id ? "pds:g:" + compactId(id) : "pds:home:" + action.product,
          },
        ],
        ...(action.product
          ? [[{ text: "📘 Документы модели", callback_data: "pds:home:" + action.product }]]
          : []),
        [{ text: "🏠 Главное меню", callback_data: "home" }],
      ],
    };
  }
  // Sending is outside the operation catch. An uncertain Telegram delivery is never retried here.
  const chars = Array.from(view.text);
  for (let i = 0; i < chars.length; i += 1700) {
    await tg("sendMessage", {
      chat_id: chat.id,
      text: chars.slice(i, i + 1700).join(""),
      link_preview_options: { is_disabled: true },
      ...(i + 1700 >= chars.length ? { reply_markup: { inline_keyboard: view.rows } } : {}),
    });
  }
  return;
}
