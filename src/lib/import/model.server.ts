import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { can, type StaffMember } from "@/lib/bot/permissions";
import { isPrivateChat } from "@/lib/bot/catalog";
import { tg } from "@/lib/bot/telegram.server";
import {
  modelQuestions,
  parseModelCallback,
  renderModel,
  type ModelView,
  type ModelPrompt,
} from "./model-view";

type Chat = { id: number; type?: string };
const rpc = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ data: ModelView | null; error: { message?: string } | null }>;
const errors: Record<string, string> = {
  DOCUMENT_MODEL_ROW_REVIEW:
    "Сначала проверьте строку документа и завершите исправление таблицы. Пропущенная или заменённая строка не подходит.",
  DOCUMENT_MODEL_SOURCE_CHANGED:
    "Исходная строка изменилась. Откройте модель и заполните сведения заново; прежнее решение осталось в истории.",
  DOCUMENT_MODEL_STALE: "Кнопка или ответ устарели. Откройте текущее состояние модели.",
  DOCUMENT_MODEL_INCOMPLETE:
    "Укажите производителя, модель и решение о модификации. Завершите вопрос, затем проверьте карточку.",
  DOCUMENT_MODEL_VALUE:
    "Введите непустое значение одной строкой: производитель до 100 знаков, модель и модификация до 150. Если не уверены, оставьте модель на проверке.",
  DOCUMENT_MODEL_QUESTION:
    "Ответьте на текущий вопрос. При потере сообщения откройте модель и нажмите «Получить новый вопрос».",
  DOCUMENT_MODEL_DENIED: "Разбор документов доступен администратору с правом импорта.",
  DOCUMENT_INPUT_ACTIVE:
    "Сначала завершите текущий вопрос. /input — продолжить, /cancel — закрыть ввод.",
  DOCUMENT_OTHER_INPUT:
    "Сначала завершите другой ввод товара: /input или /technical. /cancel закрывает текущий диалог.",
};
function allowed(m: StaffMember, chat: Chat) {
  return (
    isPrivateChat(chat, { id: m.telegram_id }) && can(m, "import_prices") && can(m, "view_costs")
  );
}
async function call(
  m: StaffMember,
  op: string,
  id: string,
  row: number,
  revision?: number,
  payload: Record<string, unknown> = {},
) {
  const { data, error } = await rpc("bot_document_model", {
    p_actor: m.telegram_id,
    p_op: op,
    p_id: id,
    p_row: row,
    p_revision: revision,
    p_payload: payload,
  });
  if (error || !data?.ok) throw new Error(error?.message ?? "DOCUMENT_MODEL_READ");
  return data;
}
async function send(chat: Chat, text: string, rows: { text: string; callback_data: string }[][]) {
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += 3500)
    await tg("sendMessage", {
      chat_id: chat.id,
      text: chars.slice(i, i + 3500).join(""),
      ...(i + 3500 >= chars.length ? { reply_markup: { inline_keyboard: rows } } : {}),
    });
}
async function display(
  m: StaffMember,
  chat: Chat,
  r: ModelView,
  question = false,
  history = false,
) {
  const view = renderModel(r, history);
  await send(chat, view.text, view.rows);
  if (!question || r.focus < 0 || !r.prompt || !r.eligible || r.stale) return;
  const response = await tg("sendMessage", {
    chat_id: chat.id,
    text: modelQuestions[r.focus],
    reply_markup: { force_reply: true, input_field_placeholder: "По исходному документу" },
  });
  const result = (await response.json()) as { ok?: boolean; result?: { message_id?: number } };
  if (
    !result.ok ||
    !Number.isSafeInteger(result.result?.message_id) ||
    result.result!.message_id! <= 0
  )
    throw new Error("DOCUMENT_MODEL_QUESTION");
  await call(m, "bind", r.id, r.row, r.revision, { message_id: result.result!.message_id });
}
async function recover(chat: Chat, error: unknown, id: string, row: number) {
  await send(
    chat,
    errors[error instanceof Error ? error.message : ""] ??
      "Не удалось подтвердить действие. Откройте сохранённую модель; не вводите сведения заново вслепую.",
    [
      [{ text: "🔄 Открыть сохранённую модель", callback_data: `dm:${id}:0:get:${row}` }],
      [{ text: "📚 Документы", callback_data: "di:home" }],
    ],
  );
}
export async function showDocumentModel(m: StaffMember, chat: Chat, data: string) {
  if (!allowed(m, chat)) return;
  const action = parseModelCallback(data);
  if (!action) return;
  const { id, row, revision, op } = action;
  try {
    const r = await call(m, op === "history" ? "get" : op, id, row, revision);
    await display(
      m,
      chat,
      r,
      ["start", "askbrand", "askmodel", "askvar", "resume"].includes(op),
      op === "history",
    );
  } catch (e) {
    await recover(chat, e, id, row);
  }
}
export async function documentModelControl(
  m: StaffMember,
  chat: Chat,
  prompt: ModelPrompt,
  command: "resume" | "cancel",
) {
  if (!allowed(m, chat)) return;
  try {
    const r = await call(m, command, prompt.review_id, prompt.row_index, prompt.revision);
    await display(m, chat, r, command === "resume");
  } catch (e) {
    await recover(chat, e, prompt.review_id, prompt.row_index);
  }
}
export async function handleDocumentModelText(
  m: StaffMember,
  chat: Chat,
  prompt: ModelPrompt,
  text: string,
  replyTo?: number,
) {
  if (!allowed(m, chat)) return false;
  if (!replyTo || !prompt.message_id) {
    await send(
      chat,
      "🏷 Есть незавершённый вопрос о модели. Ответьте именно на него или нажмите «Открыть модель». Обычный текст ничего не меняет.",
      [
        [
          {
            text: "🏷 Открыть модель",
            callback_data: `dm:${prompt.review_id}:0:get:${prompt.row_index}`,
          },
        ],
      ],
    );
    return true;
  }
  try {
    const r = await call(m, "reply", prompt.review_id, prompt.row_index, prompt.revision, {
      value: text,
      reply_to: replyTo,
    });
    await display(m, chat, r, true);
  } catch (e) {
    await recover(chat, e, prompt.review_id, prompt.row_index);
  }
  return true;
}
