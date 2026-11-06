import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { can, type StaffMember } from "@/lib/bot/permissions";
import { isPrivateChat } from "@/lib/bot/catalog";
import { tg } from "@/lib/bot/telegram.server";
import { showCatalogImport } from "./catalog.server";
import {
  parseReviewCallback,
  renderReview,
  reviewButton,
  type DocumentReview,
  type ReviewButton,
} from "./review-view";

type Chat = { id: number; type?: string };
interface Prompt {
  review_id: string;
  revision: number;
  row_index: number;
  column_index: number;
  message_id: number | null;
}
type Result = DocumentReview & { idle?: boolean; prompt?: Prompt };
const rpc = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: Result | null; error: { message?: string } | null }>;
const errors: Record<string, string> = {
  DOCUMENT_OTHER_INPUT:
    "Сначала завершите или отмените текущий ввод товара. /input — продолжить обычный ввод, /technical — характеристики, /cancel — отменить незавершённый ввод. Затем вернитесь к документу.",
  DOCUMENT_DENIED: "🔒 Разбор и импорт доступны администратору с правом импорта.",
  DOCUMENT_STALE:
    "Эта кнопка или ответ устарели. Откройте строку заново: сохранённые исправления не потеряны.",
  DOCUMENT_PROMPT:
    "Ответ не привязан к текущему вопросу. Нажмите «Исправить поле» заново и ответьте на новый вопрос.",
  DOCUMENT_UNREVIEWED:
    "Есть непроверенные строки или ни одна строка не выбрана. Проверьте строки либо явно пропустите их.",
  DOCUMENT_ROW_WIDTH:
    "Строка пустая или число ячеек отличается от заголовка. Заполните недостающие поля либо пропустите строку и подготовьте исправленный файл.",
  DOCUMENT_FROZEN:
    "Разбор уже передан в импорт и закрыт для изменений. Откройте документ, чтобы перейти к результату.",
  DOCUMENT_LEGACY_IMPORT:
    "Сначала откройте и отмените прежний импорт этой таблицы. Уже применённый импорт требует отдельного разбора владельцем.",
  DOCUMENT_VALUE: "Значение слишком длинное. Допустимо до 2000 знаков.",
};
function allowed(m: StaffMember, chat: Chat) {
  return (
    isPrivateChat(chat, { id: m.telegram_id }) && can(m, "import_prices") && can(m, "view_costs")
  );
}
async function call(m: StaffMember, op: string, args: Record<string, unknown> = {}) {
  const { data, error } = await rpc("bot_document_review", {
    p_actor: m.telegram_id,
    p_op: op,
    ...args,
  });
  if (error || !data?.ok) throw new Error(error?.message ?? "DOCUMENT_RESULT");
  return data;
}
async function send(chat: Chat, text: string, rows: ReviewButton[][]) {
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += 3500)
    await tg("sendMessage", {
      chat_id: chat.id,
      text: chars.slice(i, i + 3500).join(""),
      ...(i + 3500 >= chars.length ? { reply_markup: { inline_keyboard: rows } } : {}),
    });
}
async function recover(chat: Chat, error: unknown, id?: string, row = 0) {
  const rows: ReviewButton[][] = [];
  if (id)
    rows.push([{ text: "🔄 Открыть сохранённую строку", callback_data: `dr:${id}:0:get:${row}` }]);
  rows.push([{ text: "📚 Документы", callback_data: "di:home" }]);
  await send(
    chat,
    errors[error instanceof Error ? error.message : ""] ??
      "⚠️ Результат действия пока неизвестен. Откройте сохранённую строку или документ. Не начинайте другой импорт для восстановления.",
    rows,
  );
}
async function display(chat: Chat, r: DocumentReview, screen = "get", page = 0) {
  const v = renderReview(r, screen, page);
  await send(chat, v.text, v.rows);
}
export async function openDocumentReview(
  m: StaffMember,
  chat: Chat,
  documentId: string,
  table: number,
) {
  if (!allowed(m, chat)) return;
  try {
    await display(chat, await call(m, "open", { p_id: documentId, p_row: table }));
  } catch (e) {
    await recover(chat, e);
  }
}
export async function showDocumentReview(m: StaffMember, chat: Chat, data: string) {
  if (!allowed(m, chat)) return;
  const action = parseReviewCallback(data);
  if (!action) return;
  const { id, revision, row, column, op } = action;
  try {
    const r = await call(m, ["cols", "raw"].includes(op) ? "get" : op, {
      p_id: id,
      p_revision: revision,
      p_row: row,
      p_column: column,
    });
    if (op === "handoff" && r.import_id) {
      await send(
        chat,
        "✅ Проверенные строки переданы в предпросмотр. Товары в магазине не изменены. Теперь проверьте колонки и цены.",
        [],
      );
      return showCatalogImport(m, chat, { op: "get", id: r.import_id });
    }
    if (op !== "edit")
      return display(
        chat,
        r,
        ["approve", "exclude"].includes(op) && !r.counts.pending ? "summary" : op,
        column ?? 0,
      );
    await send(
      chat,
      `✏️ Строка ${row + 1} · ${r.header[column!]}\nСейчас: ${r.cells[column!] || "(пусто)"}\n\nИсправление сохранится только в этом разборе. Затем строку нужно проверить заново. Чтобы оставить поле пустым, ответьте одним знаком «—».`,
      [[reviewButton(r, "↩️ Отмена ввода — оставить прежнее", "cancel")]],
    );
    const response = await tg("sendMessage", {
      chat_id: chat.id,
      text: `Введите значение поля «${r.header[column!]}» для строки ${row + 1}. Ответьте именно на это сообщение.`,
      reply_markup: { force_reply: true, input_field_placeholder: "Исправленное значение" },
    });
    const body = (await response.json()) as { ok?: boolean; result?: { message_id?: number } };
    const messageId = body.result?.message_id;
    if (!body.ok || !Number.isSafeInteger(messageId) || messageId! <= 0)
      throw new Error("DOCUMENT_PROMPT");
    await call(m, "bind", {
      p_id: id,
      p_revision: r.revision,
      p_row: row,
      p_column: column,
      p_payload: { message_id: messageId },
    });
  } catch (e) {
    await recover(chat, e, id, row);
  }
}
export async function documentReviewControl(
  m: StaffMember,
  chat: Chat,
  command: "resume" | "cancel",
) {
  if (!allowed(m, chat)) return false;
  try {
    const { prompt } = await call(m, "input");
    if (!prompt) return false;
    if (command === "resume") {
      await showDocumentReview(
        m,
        chat,
        `dr:${prompt.review_id}:${prompt.revision}:edit:${prompt.row_index}:${prompt.column_index}`,
      );
    } else {
      const r = await call(m, "cancel", {
        p_id: prompt.review_id,
        p_revision: prompt.revision,
        p_row: prompt.row_index,
      });
      await send(
        chat,
        "Ввод отменён. Прежнее значение поля сохранено; уже проверенные строки остались в разборе.",
        [],
      );
      await display(chat, r);
    }
  } catch (e) {
    await recover(chat, e);
  }
  return true;
}
// Called before other text editors. Only an exact persisted question may save a cell.
// Replies to other dialogs pass through; unbound text can never become a correction.
export async function handleDocumentReviewText(
  m: StaffMember,
  chat: Chat,
  text: string,
  replyTo?: number,
) {
  if (!allowed(m, chat) || !text) return false;
  let prompt: Prompt | undefined;
  try {
    const result = await call(m, "input");
    prompt = result.prompt;
    if (!prompt) return false;
    if (replyTo !== undefined && replyTo !== prompt.message_id) return false;
    if (!replyTo || !prompt.message_id) {
      await send(
        chat,
        "✏️ В документе осталось незавершённое исправление. Нажмите «Продолжить исправление» и ответьте на новый вопрос. Обычный текст ничего не меняет.",
        [
          [
            {
              text: "✏️ Продолжить исправление",
              callback_data: `dr:${prompt.review_id}:${prompt.revision}:edit:${prompt.row_index}:${prompt.column_index}`,
            },
          ],
          [
            {
              text: "↩️ Отмена ввода — оставить прежнее",
              callback_data: `dr:${prompt.review_id}:${prompt.revision}:cancel:${prompt.row_index}`,
            },
          ],
        ],
      );
      return true;
    }
    const r = await call(m, "save", {
      p_id: prompt.review_id,
      p_revision: prompt.revision,
      p_row: prompt.row_index,
      p_column: prompt.column_index,
      p_payload: { value: text.trim() === "—" ? "" : text.trim(), reply_to: replyTo },
    });
    await send(
      chat,
      "✅ Исправление сохранено. Сверьте всю строку и нажмите «Строка проверена».",
      [],
    );
    await display(chat, r);
  } catch (e) {
    await recover(chat, e, prompt?.review_id, prompt?.row_index);
  }
  return true;
}
