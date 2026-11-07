import { z } from "zod";
import { consumableGuidance } from "./dictionary";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { can, type StaffMember } from "@/lib/bot/permissions";
import { isPrivateChat } from "@/lib/bot/catalog";
import { tg } from "@/lib/bot/telegram.server";
import { technicalOperation } from "./staff.server";
import { technicalDocument } from "./schema";
import { processLabels } from "./presentation";
import {
  EditorInputError,
  editorData,
  editorAction,
  editorReply,
  editorQuestion,
  families,
  fields,
  definition,
  describeFact,
  sourceSummary,
  sourceKinds,
} from "./editor";

const sessionSchema = z.object({
  id: z.string().uuid(),
  product_id: z.string().uuid(),
  product_title: z.string(),
  revision: z.number().int().nonnegative(),
  base_version: z.number().int().nonnegative(),
  phase: z.enum(["editing", "preview", "applied", "canceled", "undone", "expired"]),
  data: editorData,
  base_document: technicalDocument.nullable(),
  prompt_message_id: z.number().int().positive().nullable(),
  expires_at: z.string(),
  review_state: z.string().nullable(),
});
type Session = z.infer<typeof sessionSchema>;
type Chat = { id: number; type?: string };
type Button = { text: string; callback_data: string };
const safeErrors: Record<string, string> = {
  DOCUMENT_INPUT_ACTIVE:
    "✏️ Сначала завершите исправление строки документа. /input — продолжить, /cancel — отменить ввод. Уже сохранённые строки останутся в разборе.",
  EDITOR_ORDINARY_ACTIVE:
    "✏️ Сначала завершите текущий ввод товара или отмените его командой /cancel. Затем снова откройте проверенные характеристики. Текущий ввод сохранён.",
  TECH_PRIMARY_SOURCE_REQUIRED:
    "Для подтверждения нужны паспорт, документ изготовителя или протокол испытаний. Поставщик/исследование — только предложение на проверку.",
  TECH_REVERSED_RANGE: "Минимальное значение больше максимального. Проверьте диапазоны.",
  TECH_BAD_SOURCE: "Проверьте источник: дату, ссылку, модель и место в документе.",
  TECH_CONTEXT_REQUIRED: "Не хватает обязательных условий измерения.",
  TECH_UNDO_EXPIRED: "Откат недоступен. Срок — 7 дней после применения.",
  TECH_DENIED: "Доступ к редактированию отозван. Обратитесь к владельцу.",
  TECH_CONFLICT:
    "⚠️ Товар или его характеристики изменились после начала работы. Черновик сохранён. Сверьте модель и источники с текущей карточкой; затем отмените черновик и начните заново.",
  TECH_EDITOR_ACTIVE:
    "У вас уже открыт черновик другого товара. /technical — продолжить или отменить его.",
  TECH_EDITOR_STALE: "Эта кнопка или ответ устарели. /technical — открыть текущий шаг.",
  TECH_EDITOR_EXPIRED:
    "Срок работы с черновиком истёк (24 часа). Начните заново из карточки товара.",
  TECH_REVIEW_DENIED: "Недостаточно прав для подтверждения этих данных.",
  TECH_PREVIEW_EXPIRED:
    "Предпросмотр действует 30 минут. Вернитесь к редактированию и проверьте его заново.",
};
async function operation(
  member: StaffMember,
  op: string,
  session?: Session,
  extra: Record<string, unknown> = {},
) {
  const rpc = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message?: string } | null }>;
  const { data, error } = await rpc("bot_technical_editor", {
    p_staff_telegram_id: member.telegram_id,
    p_op: op,
    ...(session ? { p_session_id: session.id, p_revision: session.revision } : {}),
    ...extra,
  });
  if (error)
    throw new EditorInputError(
      safeErrors[error.message ?? ""] ??
        "Не удалось подтвердить операцию. /technical — проверить сохранённый шаг. Повторно применять данные вслепую не нужно.",
    );
  const parsed = z
    .object({ ok: z.literal(true), session: sessionSchema.nullable() })
    .safeParse(data);
  if (!parsed.success)
    throw new EditorInputError("Не удалось прочитать черновик. Изменения не подтверждены.");
  return parsed.data.session;
}
function guard(member: StaffMember, chat: Chat, from: { id: number }) {
  if (!isPrivateChat(chat, from) || member.telegram_id !== from.id || !can(member, "edit_products"))
    throw new EditorInputError(
      "Редактор доступен сотруднику с правом изменения товаров только в личном чате.",
    );
}
function button(s: Session, text: string, action: string, index?: number): Button {
  const data =
    "te:" + s.id + ":" + s.revision + ":" + action + (index === undefined ? "" : ":" + index);
  if (new TextEncoder().encode(data).length > 64)
    throw new EditorInputError("Недействительная кнопка.");
  return { text: text.slice(0, 60), callback_data: data };
}
function factDiff(s: Session) {
  const before = s.base_document?.values ?? [],
    after = s.data.document?.values ?? [];
  const serialized = (v: unknown) => JSON.stringify(v);
  return (
    "Основа: версия " +
    s.base_version +
    ".\n" +
    "Добавлены/изменены: " +
    after.filter((v) => !before.some((b) => serialized(b) === serialized(v))).length +
    "; удалены/заменены: " +
    before.filter((v) => !after.some((a) => serialized(a) === serialized(v))).length +
    "."
  );
}
async function render(member: StaffMember, chat: Chat, s: Session) {
  if (["editing", "preview"].includes(s.phase) && Date.parse(s.expires_at) <= Date.now())
    s = { ...s, phase: "expired" };
  const d = s.data,
    rows: Button[][] = [];
  let text = "⚙️ Характеристики\n" + s.product_title.slice(0, 180) + "\n\n";
  const add = (label: string, action: string, index?: number) =>
    rows.push([button(s, label, action, index)]);
  if (s.phase === "applied") {
    text +=
      s.review_state === "verified"
        ? "✅ Подтверждение сохранено в истории. Откройте «Текущие характеристики», чтобы проверить, какие сведения действуют сейчас."
        : "📨 Предложение сохранено для проверки владельцем. Опубликованные сведения не изменились.";
    rows.push([{ text: "⚙️ Текущие характеристики", callback_data: "te:open:" + s.product_id }]);
    if (can(member, "publish_products")) add("↩️ Проверить откат", "askundo");
  } else if (s.phase === "canceled" || s.phase === "undone" || s.phase === "expired") {
    text +=
      s.phase === "undone"
        ? "↩️ Изменение отменено."
        : s.phase === "canceled"
          ? "Черновик отменён. Карточка не изменена."
          : "Срок черновика истёк.";
  } else if (s.phase === "preview") {
    text +=
      "👁 Предпросмотр\n" +
      factDiff(s) +
      "\n\n" +
      (s.review_state === "verified"
        ? "Будут подтверждены данные для витрины."
        : "Будет отправлено предложение на проверку. Витрина не изменится.") +
      "\nПроверьте значения и источники перед подтверждением.";
    add("📋 Значения и источники", "review");
    add(
      s.review_state === "verified" ? "✅ Подтвердить публикацию" : "📨 Отправить на проверку",
      "apply",
    );
    add("✏️ Вернуться к редактированию", "edit");
    add("Отменить черновик", "cancel_now");
  } else if (d.screen === "home") {
    text +=
      "Черновик сохраняется на 24 часа. Витрина изменится только после подтверждения владельцем.\n" +
      "Сверьте точную модель и модификацию в источниках с текущим товаром. Прежние значения не подтверждаются одним открытием черновика.\n" +
      (d.document
        ? "Семейство: " +
          (families.find((f) => f.code === d.document?.family_code)?.label ??
            d.document.family_code) +
          "\nЗначений: " +
          d.document.values.length
        : "Выберите семейство по паспорту изделия, а не только по названию.") +
      "\n\n" +
      factDiff(s);
    add("🗂 Выбрать семейство", "families");
    if (d.document) {
      add("➕ Добавить / изменить значение", "fields");
      add("📋 Проверить значения и источники", "inspect");
      add("📨 Предпросмотр предложения", "pending");
      if (can(member, "publish_products")) add("✅ Предпросмотр публикации", "verified");
    }
    add("🗑 Отменить черновик", "cancel");
  } else if (d.screen === "families") {
    const start = d.page * 8;
    text +=
      "Выберите вид товара по документу. Это не меняет раздел магазина.\n" +
      "Страница " +
      (d.page + 1) +
      " из " +
      Math.ceil(families.length / 8) +
      ". Здесь семейства с подготовленными полями; полный справочник ещё дополняется.";
    families.slice(start, start + 8).forEach((f, i) => add(f.label, "family", start + i));
    if (start > 0) add("⬅️ Предыдущие виды товаров", "families", d.page - 1);
    if (start + 8 < families.length) add("Следующие виды товаров ➡️", "families", d.page + 1);
  } else if (d.screen === "family_change") {
    text += "⚠️ Смена семейства очистит значения и источники только в этом черновике.";
    add("Подтвердить смену семейства", "family_yes");
  } else if (d.screen === "fields") {
    text += "Выберите характеристику:";
    const guidance = consumableGuidance(d.document?.family_code ?? "");
    if (guidance) text += "\n\n" + guidance;
    const all = fields(d),
      start = d.page * 8;
    all.slice(start, start + 8).forEach((f, i) => add(f.label, "field", start + i));
    if (start > 0) add("⬅️ Предыдущие", "fields", d.page - 1);
    if (start + 8 < all.length) add("Следующие ➡️", "fields", d.page + 1);
  } else if (d.screen === "process") {
    text += "Выберите режим:";
    definition(d).processes.forEach((p, i) =>
      add(processLabels[p as keyof typeof processLabels], "process", i),
    );
  } else if (d.screen === "facts") {
    text += "Можно добавить другое условие измерения или исправить существующее значение.";
    const matching = (d.document?.values ?? [])
      .map((fact, index) => ({ fact, index }))
      .filter((v) => v.fact.attribute_code === d.field && v.fact.process === d.pending?.process);
    matching
      .slice(d.page * 8, d.page * 8 + 8)
      .forEach((v) => add(describeFact(v.fact), "existing", v.index));
    if (d.page > 0) add("⬅️ Предыдущие", "factpage", d.page - 1);
    if (d.page * 8 + 8 < matching.length) add("Следующие ➡️", "factpage", d.page + 1);
    add("➕ Новое значение / другие условия", "new");
  } else if (d.screen === "value") {
    text +=
      "Введите значение ответом на следующий вопрос. Кнопки ниже позволяют явно указать отсутствие сведений.";
    add("❔ Нет подтверждённых сведений", "unknown");
    add("Не применяется к изделию", "na");
    if (d.fact !== null) {
      add("🗑 Удалить это значение", "delete");
      if (d.pending?.state === "known") add("🔎 Исправить только условия / источник", "conditions");
    }
  } else if (d.screen === "context")
    text +=
      "Укажите условие испытания ответом на следующий вопрос. Без него число не будет сохранено.";
  else if (d.screen === "sources") {
    text += "📎 Выберите источник именно этого значения или добавьте новый:";
    d.document?.sources.forEach((v, i) => add(v.model + " · " + v.title, "source", i));
    add("➕ Новый источник", "newsource");
  } else if (d.screen === "source_kind") {
    text +=
      "Вид источника. Поставщик и исследование требуют проверки и не подходят для подтверждения витрины.";
    sourceKinds.forEach((v, i) => add(v[1], "kind", i));
  } else if (d.screen === "source_input")
    text += "Заполните источник. Ответьте на следующий вопрос; ранее введённые поля сохраняются.";
  else if (d.screen === "inspect") {
    const values = d.document?.values ?? [],
      v = values[d.page];
    text += "📋 Значение " + (values.length ? d.page + 1 : 0) + " из " + values.length + "\n";
    if (v) {
      text += describeFact(v);
      const source = d.document?.sources.find((a) => a.key === v.source_key);
      if (source) text += "\n\n📎 " + sourceSummary(source);
    }
    if (d.page > 0) add("⬅️ Предыдущее", "inspect", d.page - 1);
    if (d.page + 1 < values.length) add("Следующее ➡️", "inspect", d.page + 1);
  } else if (d.screen === "cancel") {
    text += "Отменить этот черновик? Опубликованная карточка останется прежней.";
    add("Да, отменить черновик", "cancel_now");
  } else if (d.screen === "delete") {
    text += "Удалить значение из черновика? На витрине оно изменится только после подтверждения.";
    add("Да, удалить из черновика", "delete_yes");
  }
  if (s.phase === "editing" && d.screen !== "home")
    add("⬅️ К черновику (незавершённое поле не сохранять)", "home");
  rows.push([{ text: "📦 Карточка товара", callback_data: "prd:" + s.product_id }]);
  await sendLong(chat, text, rows);
  const question = s.phase === "editing" ? editorQuestion(d) : null;
  if (question) {
    const response = await tg("sendMessage", {
      chat_id: chat.id,
      text: question.slice(0, 3900),
      reply_markup: { force_reply: true },
    });
    const result: unknown = await response.json();
    const message = z
      .object({
        ok: z.literal(true),
        result: z.object({ message_id: z.number().int().positive() }),
      })
      .parse(result).result;
    await operation(member, "prompt", s, { p_prompt_message_id: message.message_id });
  }
}
async function sendLong(chat: Chat, text: string, rows: Button[][]) {
  // Plain text chunks retain complete source details and long value lists.
  const chars = Array.from(text),
    size = 3600;
  for (let offset = 0; offset < chars.length; offset += size)
    await tg("sendMessage", {
      chat_id: chat.id,
      text: chars.slice(offset, offset + size).join(""),
      ...(offset + size >= chars.length ? { reply_markup: { inline_keyboard: rows } } : {}),
    });
}
async function inspectPreview(chat: Chat, s: Session, page: number, before = false) {
  const doc = before ? s.base_document : s.data.document;
  const values = doc?.values ?? [],
    v = values[page];
  const rows: Button[][] = [];
  let text =
    (before ? "📋 Было · " : "📋 Станет · ") +
    (v ? page + 1 : 0) +
    " / " +
    values.length +
    "\n" +
    (v ? describeFact(v) : "Значений нет.");
  const source = doc?.sources.find((a) => a.key === v?.source_key);
  if (source) text += "\n\n📎 " + sourceSummary(source);
  if (page > 0) rows.push([button(s, "⬅️ Предыдущее", before ? "before" : "review", page - 1)]);
  if (page + 1 < values.length)
    rows.push([button(s, "Следующее ➡️", before ? "before" : "review", page + 1)]);
  rows.push([
    button(
      s,
      before ? "Смотреть новые значения" : "Смотреть прежние значения",
      before ? "review" : "before",
    ),
  ]);
  rows.push([button(s, "⬅️ К подтверждению", "resume")]);
  await sendLong(chat, text, rows);
}
export async function technicalEditor(
  member: StaffMember,
  chat: Chat,
  from: { id: number },
  input: { callback?: string; text?: string; replyTo?: number | undefined; command?: string },
): Promise<boolean> {
  // The dispatcher calls this only after its staff gate; keep a second explicit guard.
  try {
    guard(member, chat, from);
    if (input.command || input.callback === "te:resume") {
      const s =
        (await operation(member, "current")) ??
        (input.command === "/cancel" ? null : await operation(member, "latest"));
      if (s) {
        if (input.command === "/cancel") {
          await tg("sendMessage", {
            chat_id: chat.id,
            text: "Отменить черновик характеристик? Опубликованная карточка не изменится.",
            reply_markup: {
              inline_keyboard: [
                [button(s, "Да, отменить черновик", "cancel_now")],
                [button(s, "Продолжить", "resume")],
              ],
            },
          });
        } else await render(member, chat, s);
      } else if (input.command === "/cancel") return false;
      else
        await tg("sendMessage", {
          chat_id: chat.id,
          text: "Черновика нет. Откройте товар → Редактировать → Проверенные характеристики.",
        });
      return true;
    }
    const open = input.callback?.match(/^te:open:([0-9a-f-]{36})$/);
    if (open) {
      const id = z.string().uuid().parse(open[1]);
      const current = await operation(member, "current");
      if (current) {
        await render(member, chat, current);
        return true;
      }
      const data = await technicalOperation(member, chat, from, { op: "read", productId: id });
      const card = z
        .object({
          card: z
            .object({
              identity_review: z
                .object({
                  required: z.boolean(),
                  previous_revision: z.string().uuid().nullable().optional(),
                })
                .optional(),
              revisions: z.array(
                z.object({
                  id: z.string().uuid(),
                  review_state: z.string(),
                  created_at: z.string(),
                }),
              ),
            })
            .nullable(),
        })
        .parse(data).card;
      const rows: Button[][] = [
        [
          {
            text: card?.identity_review?.required
              ? "✏️ Начать проверку текущего товара"
              : "✏️ Править текущую опубликованную карточку",
            callback_data: "te:start:" + id,
          },
        ],
      ];
      if (
        can(member, "publish_products") &&
        card?.identity_review?.required &&
        card.identity_review.previous_revision
      ) {
        rows.push([
          {
            text: "🔎 Проверить прежние характеристики",
            callback_data: "te:proposal:" + card.identity_review.previous_revision,
          },
        ]);
      }
      if (can(member, "publish_products"))
        for (const r of card?.revisions ?? []) {
          if (r.review_state !== "verified")
            rows.push([
              {
                text: "📨 Проверить предложение " + r.created_at.slice(0, 16),
                callback_data: "te:proposal:" + r.id,
              },
            ]);
        }
      await tg("sendMessage", {
        chat_id: chat.id,
        text: card?.identity_review?.required
          ? "⚠️ Товар изменён — характеристики нужно проверить заново.\nПрежние подтверждённые сведения скрыты, история сохранена. Сверьте точную модель, значения и источники. Открытие прежней подборки не возвращает её на витрину: нужны исправления по необходимости, предпросмотр и отдельное подтверждение владельцем."
          : "⚙️ Проверенные характеристики\nНачните от текущей карточки или выберите предложение для проверки. При проверке предложение сравнивается с текущей опубликованной карточкой.",
        reply_markup: { inline_keyboard: rows },
      });
      return true;
    }
    const start = input.callback?.match(/^te:(start|proposal):([0-9a-f-]{36})$/);
    if (start) {
      const id = z.string().uuid().parse(start[2]);
      const s = await operation(
        member,
        "start",
        undefined,
        start[1] === "start" ? { p_product_id: id } : { p_source_revision: id },
      );
      if (s) await render(member, chat, s);
      return true;
    }
    if (input.callback) {
      const m = input.callback.match(/^te:([0-9a-f-]{36}):(\d+):([a-z_]+)(?::(\d+))?$/);
      if (!m) throw new EditorInputError("Кнопка устарела. /technical — продолжить.");
      const id = z.string().uuid().parse(m[1]),
        revision = Number(m[2]),
        action = m[3]!,
        index = Number(m[4] ?? 0);
      let s = await operation(member, "get", undefined, { p_session_id: id });
      if (!s) throw new EditorInputError("Черновик не найден.");
      if (action === "resume") {
        await render(member, chat, s);
        return true;
      }
      if (
        revision !== s.revision &&
        !(action === "apply" && s.phase === "applied") &&
        !(action === "undo_yes" && s.phase === "undone")
      )
        throw new EditorInputError(safeErrors["TECH_EDITOR_STALE"]);
      if ((action === "review" || action === "before") && s.phase === "preview") {
        await inspectPreview(chat, s, index, action === "before");
        return true;
      }
      if (action === "askundo" && s.phase === "applied" && can(member, "publish_products")) {
        await tg("sendMessage", {
          chat_id: chat.id,
          text: "↩️ Отменить это изменение? Откат доступен 7 дней и только если после него не было других правок.",
          reply_markup: {
            inline_keyboard: [
              [button(s, "Да, выполнить откат", "undo_yes")],
              [button(s, "Вернуться", "resume")],
            ],
          },
        });
        return true;
      }
      if (
        action === "apply" ||
        action === "undo_yes" ||
        action === "edit" ||
        action === "cancel_now"
      )
        s = await operation(
          member,
          action === "undo_yes" ? "undo" : action === "cancel_now" ? "cancel" : action,
          s,
        );
      else if (action === "pending" || action === "verified") {
        if (s.phase !== "editing" || s.data.screen !== "home")
          throw new EditorInputError("Сначала завершите ввод значения.");
        if (action === "verified" && !can(member, "publish_products"))
          throw new EditorInputError(safeErrors["TECH_REVIEW_DENIED"]);
        s = await operation(member, "preview", s, {
          p_review_state: action === "verified" ? "verified" : "pending_review",
        });
      } else {
        if (s.phase !== "editing")
          throw new EditorInputError("Редактирование этого черновика завершено.");
        s = await operation(member, "save", s, { p_data: editorAction(s.data, action, index) });
      }
      if (s) await render(member, chat, s);
      return true;
    }
    if (input.text !== undefined) {
      const s = await operation(member, "current");
      if (!s) return false;
      if (
        s.phase !== "editing" ||
        !editorQuestion(s.data) ||
        !input.replyTo ||
        input.replyTo !== s.prompt_message_id
      )
        throw new EditorInputError(
          "Ответ не привязан к текущему вопросу. /technical — продолжить черновик. Затем ответьте именно на сообщение бота.",
        );
      const next = await operation(member, "save", s, { p_data: editorReply(s.data, input.text) });
      if (next) await render(member, chat, next);
      return true;
    }
    return false;
  } catch (error) {
    // Only our fixed/model validation errors reach the user; never raw database or provider text.
    const message =
      error instanceof EditorInputError
        ? error.message
        : "Не удалось завершить шаг. /technical — проверить сохранённый черновик.";
    await tg("sendMessage", { chat_id: chat.id, text: message.slice(0, 1000) });
    return true;
  }
}
