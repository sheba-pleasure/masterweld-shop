import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { can, type StaffMember } from "@/lib/bot/permissions";
import { isPrivateChat } from "@/lib/bot/catalog";
import { tg } from "@/lib/bot/telegram.server";
import { showCatalogImport } from "./catalog.server";
import {
  parseReviewCallback,
  renderReview,
  reviewButton,
  reviewColumnLabel,
  type DocumentReview,
  type ReviewButton,
} from "./review-view";

import { parseStructureCallback, renderStructure, structureQuestion } from "./structure-view";
import { documentModelControl, handleDocumentModelText } from "./model.server";

type Chat = { id: number; type?: string };
interface Prompt {
  kind?: "cell" | "structure" | "model";
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
  DOCUMENT_STRUCTURE_PAGE:
    "Эта часть предпросмотра недоступна. Откройте сохранённую строку и проверьте исправление заново.",
  DOCUMENT_MODEL_INPUT_ACTIVE:
    "Сначала завершите вопрос о модели. /input — продолжить, /cancel — закрыть ввод.",
  DOCUMENT_MODEL_DENIED: "Разбор документов доступен администратору с правом импорта.",
  DOCUMENT_STRUCTURE_ACTIVE:
    "В таблице открыт черновик структуры. Сначала подтвердите или отмените его. /input — продолжить.",
  SOURCE_FACT_INPUT_ACTIVE:
    "Сначала завершите исправление характеристики из документа. /input — продолжить вопрос, /cancel — закрыть ввод. Сохранённые решения останутся в разборе.",
  DOCUMENT_INPUT_ACTIVE: "Сначала завершите ввод поля. /input — продолжить, /cancel — отменить.",
  DOCUMENT_ROW_REPLACED:
    "Эта строка уже заменена при исправлении структуры. Откройте текущий разбор.",
  DOCUMENT_UNDO_CONFLICT:
    "После исправления уже были другие изменения. Автоматическая отмена недоступна; откройте текущую таблицу.",
  DOCUMENT_SOURCE_NOTE:
    "Укажите место товара в исходном файле: от 1 до 300 знаков. Если точное место неизвестно, выберите соответствующую кнопку в черновике.",
  DOCUMENT_HEADER: "Название должно быть непустым, до 100 знаков и не повторять другую колонку.",
  DOCUMENT_EMPTY_PRODUCT:
    "Один из новых товаров полностью пустой. Заполните его поля перед подтверждением.",
  DOCUMENT_NO_CHANGE: "Заголовок не изменён. Выберите другое название либо отмените черновик.",
  DOCUMENT_CAPACITY: "Достигнут предел 5000 строк с учётом истории. Подготовьте меньший документ.",
  DOCUMENT_STRUCTURE_PREVIEW:
    "Откройте предпросмотр перед подтверждением или вернитесь к исправлению.",
  DOCUMENT_STRUCTURE_MISSING: "Черновик уже закрыт. Откройте текущий разбор.",
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
// Only an explicit RPC refusal can establish that the answer was not saved.
class DocumentOperationError extends Error {}
async function call(m: StaffMember, op: string, args: Record<string, unknown> = {}) {
  const { data, error } = await rpc("bot_document_review", {
    p_actor: m.telegram_id,
    p_op: op,
    ...args,
  });
  if (error || !data?.ok) throw new DocumentOperationError(error?.message ?? "DOCUMENT_RESULT");
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
async function recover(chat: Chat, error: unknown, id?: string, row = 0, prompt?: Prompt) {
  const rows: ReviewButton[][] = [];
  const rejectedAnswer =
    prompt &&
    prompt.kind !== "model" &&
    error instanceof DocumentOperationError &&
    ["DOCUMENT_VALUE", "DOCUMENT_HEADER", "DOCUMENT_SOURCE_NOTE"].includes(error.message);
  if (rejectedAnswer)
    rows.push([
      {
        text: "✏️ Повторить ввод",
        callback_data: `dr:${prompt.review_id}:${prompt.revision}:resume:${prompt.row_index}`,
      },
    ]);
  if (id)
    rows.push([{ text: "🔄 Открыть сохранённую строку", callback_data: `dr:${id}:0:get:${row}` }]);
  rows.push([{ text: "📚 Документы", callback_data: "di:home" }]);
  await send(
    chat,
    (errors[error instanceof Error ? error.message : ""] ??
      "⚠️ Результат действия пока неизвестен. Откройте сохранённую строку или документ. Не начинайте другой импорт для восстановления.") +
      (rejectedAnswer
        ? "\n\nЭтот ответ не сохранён. Нажмите «Повторить ввод» и ответьте на новый вопрос. Ранее сохранённые исправления остаются в разборе."
        : ""),
    rows,
  );
}
async function display(chat: Chat, r: DocumentReview, screen = "get", page = 0) {
  const v = r.structure_draft ? renderStructure(r, screen, page) : renderReview(r, screen, page);
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
    if (op === "resume") {
      const { prompt } = await call(m, "input");
      if (
        !prompt ||
        prompt.kind === "model" ||
        prompt.review_id !== id ||
        prompt.revision !== revision ||
        prompt.row_index !== row
      )
        throw new Error("DOCUMENT_STALE");
      if (prompt.kind === "structure") {
        const current = await call(m, "get", { p_id: id, p_row: row });
        const draft = current.structure_draft;
        if (
          current.revision !== revision ||
          !draft ||
          draft.stage !== "editing" ||
          draft.target !== row ||
          draft.focus !== prompt.column_index ||
          draft.focus < -1
        )
          throw new Error("DOCUMENT_STALE");
        const operation = draft.focus === -1 ? "src" : draft.guided ? "walk" : "edit";
        return showDocumentStructure(
          m,
          chat,
          `ds:${id}:${revision}:${operation}:${row}${draft.focus === -1 ? "" : ":" + draft.focus}`,
        );
      }
      await showDocumentReview(m, chat, `dr:${id}:${revision}:edit:${row}:${prompt.column_index}`);
      return;
    }
    const r = await call(
      m,
      ["cols", "raw", "values", "full", "orig", "checks", "page"].includes(op) ? "get" : op,
      {
        p_id: id,
        p_revision: revision,
        p_row: row,
        p_column: column,
      },
    );
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
      `✏️ Строка ${r.position ?? row + 1} · ${reviewColumnLabel(r.header[column!], column!)}\nСейчас: ${r.cells[column!] || "(пусто)"}\n\nИсправление сохранится только в этом разборе. Затем строку нужно проверить заново. Чтобы оставить поле пустым, ответьте одним знаком «—».`,
      [[reviewButton(r, "↩️ Отмена ввода — оставить прежнее", "cancel")]],
    );
    const response = await tg("sendMessage", {
      chat_id: chat.id,
      text: `Введите значение поля «${reviewColumnLabel(r.header[column!], column!)}» для строки ${r.position ?? row + 1}. Ответьте именно на это сообщение.`,
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
    if (prompt.kind === "model") {
      await documentModelControl(m, chat, prompt, command);
      return true;
    }
    if (prompt.kind === "structure") {
      const r = await call(m, command === "cancel" ? "st_cancel" : "get", {
        p_id: prompt.review_id,
        p_revision: prompt.revision,
        p_row: prompt.row_index,
      });
      if (command === "resume" && r.structure_draft && r.structure_draft.focus >= -1) {
        const fresh = await call(m, "st_focus", {
          p_id: r.id,
          p_revision: r.revision,
          p_row: r.structure_draft.target,
          p_column: r.structure_draft.focus,
          p_payload: { guided: r.structure_draft.guided },
        });
        await structureDisplay(m, chat, fresh, true);
      } else await display(chat, r);
      return true;
    }
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
    if (prompt.kind === "model") return handleDocumentModelText(m, chat, prompt, text, replyTo);
    if (prompt.kind === "structure") {
      if (!replyTo || !prompt.message_id) {
        await send(
          chat,
          "🛠 Есть незавершённый черновик таблицы. /input — продолжить, /cancel — отменить. Обычный текст ничего не меняет.",
          [
            [
              {
                text: "🛠 Открыть черновик",
                callback_data: `ds:${prompt.review_id}:${prompt.revision}:tools:${prompt.row_index}`,
              },
            ],
          ],
        );
        return true;
      }
      const r = await call(m, "st_save", {
        p_id: prompt.review_id,
        p_revision: prompt.revision,
        p_row: prompt.row_index,
        p_column: prompt.column_index,
        p_payload: { value: text.trim() === "—" ? "" : text.trim(), reply_to: replyTo },
      });
      await structureDisplay(m, chat, r, true);
      return true;
    }
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
    await recover(chat, e, prompt?.review_id, prompt?.row_index, prompt);
  }
  return true;
}

async function structureDisplay(
  m: StaffMember,
  chat: Chat,
  r: DocumentReview,
  ask = false,
  screen = "tools",
  arg = 0,
) {
  if (!r.structure_draft && !["tools", "heads", "parts", "askundo"].includes(screen))
    return display(chat, r);
  const view = renderStructure(r, screen, arg);
  await send(chat, view.text, view.rows);
  const d = r.structure_draft;
  if (!ask || !d || d.stage !== "editing" || d.focus < -1) return;
  const response = await tg("sendMessage", {
    chat_id: chat.id,
    text: structureQuestion(r),
    reply_markup: {
      force_reply: true,
      input_field_placeholder: d.focus === -1 ? "Место в документе" : "Значение одного поля",
    },
  });
  const body = (await response.json()) as { ok?: boolean; result?: { message_id?: number } };
  const messageId = body.result?.message_id;
  if (!body.ok || !Number.isSafeInteger(messageId) || messageId! <= 0)
    throw new Error("DOCUMENT_PROMPT");
  await call(m, "st_bind", {
    p_id: r.id,
    p_revision: r.revision,
    p_row: d.target,
    p_column: d.focus,
    p_payload: { message_id: messageId },
  });
}
export async function showDocumentStructure(m: StaffMember, chat: Chat, data: string) {
  if (!allowed(m, chat)) return;
  const action = parseStructureCallback(data);
  if (!action) return;
  const { id, revision, row, op, arg } = action;
  try {
    const reads = ["tools", "heads", "parts", "askundo", "fields", "page"];
    const operation = reads.includes(op)
      ? "get"
      : ({
          edit: "st_focus",
          walk: "st_focus",
          src: "st_focus",
          std: "st_standard",
          where: "st_where",
        }[op] ?? "st_" + op);
    const r = await call(m, operation, {
      p_id: id,
      p_revision: revision,
      p_row: row,
      p_column: ["src", "where"].includes(op) ? -1 : arg,
      p_payload: { guided: op === "walk" },
    });
    if (op === "page" && (r.revision !== revision || r.structure_draft?.stage !== "preview"))
      throw new Error("DOCUMENT_STALE");
    if (["apply", "cancel", "undo"].includes(op)) return display(chat, r);
    await structureDisplay(m, chat, r, !reads.includes(op), op, arg ?? 0);
  } catch (error) {
    await recover(chat, error, id, row);
  }
}
