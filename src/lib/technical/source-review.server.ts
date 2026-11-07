import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { can, type StaffMember } from "@/lib/bot/permissions";
import { isPrivateChat } from "@/lib/bot/catalog";
import { tg } from "@/lib/bot/telegram.server";
import { compactId, sourceReviewResponse } from "@/lib/import/primary-source-view";
import dictionary from "./dictionary";
import { EditorInputError, families, technicalFieldDefinition } from "./editor";
import { extractSourceCandidates } from "./source-candidates";
import { technicalProcess } from "./schema";
import {
  parseSourceFactAnswer,
  sourceFactInputFields,
  sourceFactQuestion,
} from "./source-review-input";
import {
  parseSourceFactCallback,
  renderSourceFactFamilies,
  renderSourceFactReview,
  sourceFactButton,
  sourceFactReviewResponse,
  type SourceFactAction,
  type SourceFactCallback,
  type SourceFactReview,
  type SourceFactView,
} from "./source-review-view";

type Chat = { id: number; type?: string };
type Sender = { id: number };
type Output = { view: SourceFactView } | { question: SourceFactReview };
const uuid = z.string().uuid();
const idle = z.object({ ok: z.literal(true), idle: z.literal(true) }).strict();
const messages: Record<string, string> = {
  SOURCE_FACT_ACTIVE:
    "У вас уже есть начатый разбор. Откройте его и продолжите либо закройте перед новым.",
  SOURCE_FACT_STALE_BUTTON:
    "Эта кнопка или ответ относятся к прежнему шагу. Откройте сохранённую строку.",
  SOURCE_FACT_QUESTION_STALE:
    "Этот вопрос уже закрыт или заменён. Откройте текущий разбор и выберите исправление заново.",
  SOURCE_FACT_WRONG_QUESTION:
    "Ответьте именно на последнее сообщение с вопросом. /input — показать новый вопрос, /cancel — закрыть ввод.",
  SOURCE_FACT_SOURCE_STALE:
    "Документ, выбранная модель или карточка изменились. Прочитайте сохранённый разбор; для исправления нужна новая проверка.",
  SOURCE_FACT_EXPIRED: "Срок разбора истёк. Сохранённые решения остались в истории.",
  SOURCE_FACT_OTHER_INPUT:
    "Сначала завершите другой открытый ввод. /input — продолжить его, /cancel — закрыть вопрос. Затем вернитесь к разбору.",
  SOURCE_FACT_INPUT_ACTIVE:
    "Сначала завершите исправление характеристики. /input — продолжить вопрос, /cancel — закрыть ввод.",
  SOURCE_FACT_QUESTION_BOUND:
    "Вопрос уже связан с другим сообщением. Нажмите «Продолжить вопрос», чтобы открыть новый.",
  SOURCE_FACT_DENIED: "Доступ к разбору документов отозван. Обратитесь к владельцу.",
  SOURCE_FACT_PUBLISHER_REQUIRED: "Укажите организацию, которая выпустила документ.",
  SOURCE_FACT_DECISIONS_REQUIRED:
    "Остались строки без решения. Проверьте каждую или выберите «Пропустить».",
  SOURCE_FACT_ACCEPTED_LIMIT: "Для итога нужно выбрать от 1 до 128 характеристик.",
  SOURCE_FACT_SOURCE_LIMIT:
    "Выбрано больше 32 мест в документе. Разделите проверку на отдельные разборы.",
  SOURCE_FACT_LOCATOR_REQUIRED:
    "Укажите точную страницу, таблицу или раздел в оригинале, затем проверьте строку снова.",
  SOURCE_FACT_ATTRIBUTE: "Сначала выберите подходящую характеристику и режим по документу.",
  SOURCE_FACT_NOT_EDITING:
    "Сейчас открыт предпросмотр. Вернитесь к проверке строк перед исправлением.",
  TECH_CONTEXT_REQUIRED:
    "Не хватает обязательных условий измерения. Откройте «Исправить строку → Условия измерения».",
  TECH_BAD_CONTEXT: "Проверьте значение условия и единицу измерения.",
  TECH_BAD_TYPE: "Значение не соответствует выбранному полю. Откройте исправление значения.",
  TECH_BAD_RANGE: "Значение вне допустимого диапазона. Проверьте число и единицу по оригиналу.",
  TECH_BAD_OPTION:
    "Обозначение не входит в список выбранной характеристики. Проверьте назначение поля.",
  TECH_DUPLICATE_VALUE: "В списке повторяются одинаковые значения. Уберите повтор при исправлении.",
  TECH_BAD_VALUE:
    "Есть повторяющиеся или несовместимые значения. Сверьте назначение поля, режим и условия измерения.",
  TECH_REVERSED_RANGE: "Минимальное значение превышает максимальное. Проверьте обе строки.",
};
const rpc = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message?: string } | null }>;
function allowed(m: StaffMember, chat: Chat, from: Sender) {
  return (
    m.telegram_id === from.id &&
    isPrivateChat(chat, from) &&
    can(m, "import_prices") &&
    can(m, "view_costs")
  );
}
function safeError(error: { message?: string } | null) {
  const code = error?.message;
  return new Error(code && Object.hasOwn(messages, code) ? code : "SOURCE_FACT_RESULT");
}
async function facts(
  m: StaffMember,
  op: string,
  id?: string,
  rev?: number,
  index = 0,
  payload: Record<string, unknown> = {},
  allowMissing = false,
): Promise<SourceFactReview | null> {
  const { data, error } = await rpc("bot_source_fact_review", {
    p_actor: m.telegram_id,
    p_op: op,
    p_id: id ?? null,
    p_revision: rev ?? null,
    p_index: index,
    p_payload: payload,
  });
  if (allowMissing && op === "get" && error?.message === "SOURCE_FACT_NOT_FOUND") return null;
  if (error) throw safeError(error);
  if (["current", "input"].includes(op) && idle.safeParse(data).success) return null;
  const v = sourceFactReviewResponse.parse(data);
  if (
    v.review.actor !== m.telegram_id ||
    (id && v.review.id !== id) ||
    (op === "input"
      ? !v.prompt || v.row?.row_index !== v.prompt.row_index
      : v.row !== null && v.row.row_index !== index)
  )
    throw new Error("SOURCE_FACT_RESULT");
  return v;
}
function requireReview(v: SourceFactReview | null): SourceFactReview {
  if (!v) throw new Error("SOURCE_FACT_RESULT");
  return v;
}
function recovery(error: unknown, r?: SourceFactReview, id?: string, row = 0): SourceFactView {
  const saved = r?.review.id ?? id;
  const text =
    error instanceof EditorInputError
      ? error.message
      : error instanceof Error
        ? messages[error.message]
        : undefined;
  const rows: SourceFactView["rows"] = [
    [
      {
        text: "🔄 Прочитать сохранённый разбор",
        callback_data: saved
          ? sourceFactButton({ id: saved, revision: 0 }, "row", row)
          : "sf:current",
      },
    ],
  ];
  if (saved)
    rows.push(
      [
        {
          text: "📋 Открыть список строк",
          callback_data: sourceFactButton({ id: saved, revision: 0 }, "list", 0),
        },
      ],
      [{ text: "🧾 Мой текущий разбор", callback_data: "sf:current" }],
    );
  if (r?.prompt) {
    rows.push([
      {
        text: "✏️ Продолжить вопрос",
        callback_data: sourceFactButton(r.review, "resume", r.prompt.row_index),
      },
    ]);
    rows.push([
      {
        text: "Отменить только вопрос",
        callback_data: sourceFactButton(r.review, "stop", r.prompt.row_index),
      },
    ]);
  }
  rows.push([{ text: "📚 Документы", callback_data: "di:home" }]);
  return {
    text:
      "⚠️ " +
      (text ?? "Не удалось прочитать результат. Это не означает, что действие не сохранилось.") +
      "\n\nСначала прочитайте сохранённый разбор. Новая попытка записи автоматически не запускается.",
    rows,
  };
}
const empty: SourceFactView = {
  text: "🧾 Разбор характеристик ещё не начат.\n\nОткройте товар → «Модель и исходные документы» → «Паспорта и документы». Подтвердите свой файл для выбранной модели, затем нажмите «Проверить характеристики».",
  rows: [
    [{ text: "📦 Найти товар", callback_data: "fndh" }],
    [{ text: "📚 Документы", callback_data: "di:home" }],
  ],
};
async function send(chat: Chat, view: SourceFactView) {
  const chars = Array.from(view.text);
  for (let i = 0; i < chars.length; i += 1700) {
    await tg("sendMessage", {
      chat_id: chat.id,
      text: chars.slice(i, i + 1700).join(""),
      link_preview_options: { is_disabled: true },
      ...(i + 1700 >= chars.length ? { reply_markup: { inline_keyboard: view.rows } } : {}),
    });
  }
}
async function deliver(m: StaffMember, chat: Chat, output: Output) {
  if ("view" in output) return send(chat, output.view);
  const v = output.question,
    p = v.prompt;
  if (!p || p.message_id !== null || v.row?.row_index !== p.row_index)
    throw new Error("SOURCE_FACT_RESULT");
  const text =
    "🧾 Строка " +
    (p.row_index + 1) +
    " · " +
    v.product_title.slice(0, 100) +
    "\nДокумент: " +
    v.file_name.slice(0, 100) +
    "\n\n" +
    sourceFactQuestion(v.review.family_code, v.row.draft?.attribute_code ?? null, p.field);
  if (text.length > 3800) throw new Error("SOURCE_FACT_QUESTION_LENGTH");
  // Do not catch/retry an unknown Telegram delivery. The unbound question remains recoverable.
  const response = await tg("sendMessage", {
    chat_id: chat.id,
    text,
    link_preview_options: { is_disabled: true },
    reply_markup: {
      force_reply: true,
      selective: true,
      input_field_placeholder: "Ответьте на этот вопрос",
    },
  });
  const result = z
    .object({
      ok: z.literal(true),
      result: z.object({ message_id: z.number().int().positive().safe() }),
    })
    .parse(await response.json());
  let failure: SourceFactView | undefined;
  try {
    const bound = await facts(m, "bind", v.review.id, v.review.revision, p.row_index, {
      message_id: result.result.message_id,
    });
    if (
      !bound?.prompt ||
      bound.prompt.message_id !== result.result.message_id ||
      bound.prompt.field !== p.field ||
      bound.review.revision !== v.review.revision
    )
      throw new Error("SOURCE_FACT_RESULT");
  } catch (error) {
    failure = recovery(error, v, undefined, p.row_index);
  }
  // A failed/uncertain bind asks for a read or explicit resume, never another automatic question.
  if (failure) await send(chat, failure);
}
async function sourceForStart(
  m: StaffMember,
  action: Extract<SourceFactCallback, { kind: "families" | "start" }>,
) {
  const { data, error } = await rpc("bot_product_sources", {
    p_actor: m.telegram_id,
    p_op: "get",
    p_id: action.sourceReview,
    p_product: null,
    p_revision: null,
    p_payload: {},
  });
  if (error) throw new Error("SOURCE_FACT_SOURCE_STALE");
  const v = sourceReviewResponse.parse(data),
    r = v.review;
  if (
    !r ||
    r.id !== action.sourceReview ||
    r.product_id !== v.product_id ||
    r.revision !== action.revision ||
    r.phase !== "confirmed" ||
    !r.usable ||
    !r.model_matches ||
    !r.source_id ||
    !r.document
  )
    throw new Error("SOURCE_FACT_SOURCE_STALE");
  return r;
}
async function prepare(
  m: StaffMember,
  action: Extract<SourceFactCallback, { kind: "families" | "start" }>,
  requestId: string,
): Promise<SourceFactView> {
  if (action.kind === "families") {
    await sourceForStart(m, action);
    return renderSourceFactFamilies(action.sourceReview, action.revision, action.index);
  }
  if (!uuid.safeParse(requestId).success) throw new Error("SOURCE_FACT_RESULT");
  const family = families[action.index]!;
  const prior = await facts(m, "get", requestId, undefined, 0, {}, true);
  if (prior) {
    if (prior.source_review_id !== action.sourceReview || prior.review.family_code !== family.code)
      throw new Error("SOURCE_FACT_RESULT");
    return renderSourceFactReview(prior);
  }
  const r = await sourceForStart(m, action);
  const raw = await rpc("bot_document_intake", {
    p_actor: m.telegram_id,
    p_op: "get",
    p_id: r.document!.id,
    p_payload: {},
  });
  if (raw.error) throw new Error("SOURCE_FACT_SOURCE_STALE");
  const doc = z
    .object({
      ok: z.literal(true),
      id: z.string().uuid(),
      state: z.literal("review"),
      checksum: z.string(),
      extraction: z.unknown(),
    })
    .parse(raw.data);
  if (doc.id !== r.document!.id || doc.checksum !== r.document!.checksum)
    throw new Error("SOURCE_FACT_SOURCE_STALE");
  const candidates = extractSourceCandidates(doc.extraction, doc.checksum, family.code);
  if (
    candidates.warnings.includes("input_invalid") ||
    candidates.warnings.includes("checksum_mismatch")
  )
    throw new Error("SOURCE_FACT_SOURCE_STALE");
  if (!candidates.candidates.length && !candidates.unmatched_entries.length)
    return {
      text: "📄 Не удалось выделить строки характеристик для проверки.\n\nОткройте исходный текст или оригинал. Сложная таблица, рисунок либо нечитаемый текст требуют ручного разбора. Значения не будут придуманы.",
      rows: [
        [{ text: "📘 Открыть документ", callback_data: "pds:g:" + compactId(action.sourceReview) }],
        [{ text: "📦 Открыть товар", callback_data: "prd:" + r.product_id }],
      ],
    };
  const result = requireReview(
    await facts(m, "prepare", requestId, undefined, 0, {
      source_id: r.source_id,
      result: candidates,
    }),
  );
  if (
    result.source_review_id !== action.sourceReview ||
    result.review.family_code !== family.code ||
    result.document_id !== doc.id ||
    result.document_checksum !== doc.checksum
  )
    throw new Error("SOURCE_FACT_RESULT");
  return renderSourceFactReview(result);
}
const readActions: SourceFactAction[] = [
  "list",
  "row",
  "fix",
  "fields",
  "modes",
  "conditions",
  "quote",
  "missing",
  "issues",
  "askcancel",
];
export async function showSourceFactReview(
  m: StaffMember,
  chat: Chat,
  from: Sender,
  data: string,
  requestId = "",
) {
  if (!allowed(m, chat, from)) return;
  const action = parseSourceFactCallback(data);
  if (!action) return;
  let output: Output, v: SourceFactReview | undefined;
  try {
    if (action.kind === "current") {
      v = (await facts(m, "current")) ?? undefined;
      output = { view: v ? renderSourceFactReview(v) : empty };
    } else if (action.kind === "families" || action.kind === "start") {
      output = { view: await prepare(m, action, requestId) };
    } else {
      v = requireReview(await facts(m, "get", action.id, undefined, action.index));
      if (readActions.includes(action.action)) {
        // Read-only navigation opens the persisted row even after an old button. Every new write gets its current version.
        output = {
          view: renderSourceFactReview(v, action.action, action.index, action.args[0] ?? 0),
        };
      } else {
        if (v.review.revision !== action.revision) throw new Error("SOURCE_FACT_STALE_BUTTON");
        let op: string = action.action,
          payload: Record<string, unknown> = {};
        if (action.action === "prompt") payload = { field: sourceFactInputFields[action.args[0]!] };
        if (action.action === "resume") {
          if (!v.prompt || v.prompt.row_index !== action.index)
            throw new Error("SOURCE_FACT_QUESTION_STALE");
          op = "prompt";
          payload = { field: v.prompt.field };
        }
        if (action.action === "stop") op = "cancel_input";
        if (action.action === "map") {
          const a = dictionary.attributes[action.args[0]!]!;
          const definition = technicalFieldDefinition(v.review.family_code, a.code);
          const process = technicalProcess.options[action.args[1]!]!;
          if (!definition.processes.includes(process)) throw new Error("SOURCE_FACT_ATTRIBUTE");
          payload = { attribute_code: a.code, process };
        }
        v = requireReview(await facts(m, op, action.id, action.revision, action.index, payload));
        output =
          op === "prompt"
            ? { question: v }
            : {
                view: renderSourceFactReview(
                  v,
                  ["preview", "edit", "cancel"].includes(op) ? "list" : "row",
                  action.index,
                ),
              };
      }
    }
  } catch (error) {
    output = {
      view: recovery(
        error,
        v,
        action.kind === "review"
          ? action.id
          : action.kind === "start" && uuid.safeParse(requestId).success
            ? requestId
            : undefined,
        action.kind === "review" ? action.index : 0,
      ),
    };
    if (action.kind === "families" || action.kind === "start")
      output.view.rows.push([
        { text: "📘 К документу", callback_data: "pds:g:" + compactId(action.sourceReview) },
      ]);
  }
  // Delivery is outside the operation catch; no hidden resend or mutation replay on send failure.
  await deliver(m, chat, output);
}

export async function sourceFactControl(
  m: StaffMember,
  chat: Chat,
  from: Sender,
  mode: "resume" | "cancel",
): Promise<boolean> {
  if (!allowed(m, chat, from)) return false;
  let output: Output, v: SourceFactReview | undefined;
  try {
    v = (await facts(m, "input")) ?? undefined;
    if (!v) return false;
    const p = v.prompt!;
    v = requireReview(
      await facts(
        m,
        mode === "resume" ? "prompt" : "cancel_input",
        v.review.id,
        v.review.revision,
        p.row_index,
        mode === "resume" ? { field: p.field } : {},
      ),
    );
    output =
      mode === "resume" ? { question: v } : { view: renderSourceFactReview(v, "row", p.row_index) };
  } catch (error) {
    output = { view: recovery(error, v, undefined, v?.prompt?.row_index ?? 0) };
  }
  await deliver(m, chat, output);
  return true;
}
export async function handleSourceFactText(
  m: StaffMember,
  chat: Chat,
  from: Sender,
  text: string,
  replyTo?: number,
): Promise<boolean> {
  if (!allowed(m, chat, from)) return false;
  let output: Output, v: SourceFactReview | undefined;
  try {
    v = (await facts(m, "input")) ?? undefined;
    if (!v) return false;
    const p = v.prompt!;
    if (!replyTo || p.message_id !== replyTo) throw new Error("SOURCE_FACT_WRONG_QUESTION");
    const value = parseSourceFactAnswer(
      v.review.family_code,
      v.row?.draft?.attribute_code ?? null,
      p.field,
      text,
    );
    v = requireReview(
      await facts(m, "reply", v.review.id, v.review.revision, p.row_index, {
        reply_to: replyTo,
        value,
      }),
    );
    output = { view: renderSourceFactReview(v, "row", p.row_index) };
  } catch (error) {
    output = { view: recovery(error, v, undefined, v?.prompt?.row_index ?? 0) };
  }
  await deliver(m, chat, output);
  return true;
}
