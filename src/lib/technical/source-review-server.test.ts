import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), tg: vi.fn(), from: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc, from: mocks.from },
}));
vi.mock("@/lib/bot/telegram.server", () => ({ tg: mocks.tg }));
import {
  handleSourceFactText,
  showSourceFactReview,
  sourceFactControl,
} from "./source-review.server";
import { handleUpdate } from "@/lib/bot/handler.server";
import {
  sourceFactButton,
  sourceFactFamilyButton,
  type SourceFactReview,
} from "./source-review-view";
import { families } from "./editor";
import type { StaffMember } from "@/lib/bot/permissions";
const id = "10000000-0000-4000-8000-000000000001",
  source = "20000000-0000-4000-8000-000000000002",
  docId = "30000000-0000-4000-8000-000000000003",
  sourceReview = "40000000-0000-4000-8000-000000000004";
const member: StaffMember = {
  telegram_id: 101,
  name: "Учебный",
  role: "admin",
  active: true,
  elevated: false,
};
const chat = { id: 101, type: "private" },
  from = { id: 101 };
function fixture(): SourceFactReview {
  const model = {
    state: "selected" as const,
    revision: 1,
    sources_version: 1,
    usable: true,
    choice_id: id,
    identity: {
      manufacturer: "Учебный",
      model: "QA-160",
      variant_mode: "none" as const,
      variant: "",
    },
  };
  const row = {
    row_index: 0,
    decision: "pending" as const,
    locator_override: null,
    proposal: {
      label: "Максимальный ток MMA",
      value: 160,
      issues: ["model_scope_review"],
      evidence: {
        kind: "block" as const,
        block: 0,
        locator: "page:1",
        page: 1,
        start: 0,
        end: 25,
        offset_unit: "unicode_codepoints" as const,
        quote: "Максимальный ток MMA: 160 А",
      },
    },
    draft: {
      attribute_code: "mma_current_max_a",
      process: "mma" as const,
      unit_code: "a",
      value: 160,
      context: {},
    },
  };
  return {
    ok: true,
    idle: false,
    review: {
      id,
      actor: 101,
      source_id: source,
      product_id: id,
      family_code: "power_mma",
      model_context: model,
      base_version: 0,
      publisher: null,
      revision: 4,
      phase: "reviewing",
      editor_session_id: null,
      prepared_document: null,
      merge_preview: null,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      preview_expires_at: null,
    },
    source_review_id: sourceReview,
    document_id: docId,
    document_checksum: "a".repeat(64),
    file_name: "[Учебный] Паспорт.txt",
    source_kind: "manual",
    product_title: "[Учебный] Аппарат",
    usable: true,
    handoff_supported: false,
    retained_sources: null,
    current_model: model,
    counts: { total: 1, pending: 1, accepted: 0, skipped: 0 },
    rows: [row],
    row,
    next_pending: 0,
    missing_fields: [],
    warnings: [],
    prompt: null,
  };
}
let stored: SourceFactReview | null,
  fail: string | null,
  sourceData: Record<string, unknown>,
  documentData: Record<string, unknown>;
let override: unknown | undefined;
const calls = () => mocks.rpc.mock.calls.map(([name, args]) => name + ":" + args.p_op);
const texts = () =>
  mocks.tg.mock.calls
    .filter(([method]) => method === "sendMessage")
    .map(([, p]) => p.text)
    .join("\n");
const questions = () =>
  mocks.tg.mock.calls.filter(
    ([method, p]) => method === "sendMessage" && p.reply_markup?.force_reply,
  );
function pending(message = 900) {
  stored = fixture();
  stored.prompt = {
    actor: 101,
    review_id: id,
    revision: 4,
    row_index: 0,
    field: "value",
    message_id: message,
    expires_at: stored.review.expires_at,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TELEGRAM_BOT_ID", "8996533708");
  stored = fixture();
  fail = null;
  override = undefined;
  const model = stored.review.model_context;
  sourceData = {
    ok: true,
    product_id: id,
    title: "[Учебный] Аппарат",
    current_model: model,
    active_review: null,
    page: 0,
    pages: 1,
    sources: null,
    review: {
      id: sourceReview,
      product_id: id,
      revision: 5,
      phase: "confirmed",
      model_context: model,
      model_matches: true,
      source_kind: "manual",
      source_id: source,
      usable: true,
      can_confirm: false,
      document: { id: docId, file_name: "[Учебный] Паспорт.txt", checksum: "a".repeat(64) },
      documents: null,
      page: 0,
      pages: 1,
    },
  };
  documentData = {
    ok: true,
    id: docId,
    state: "review",
    checksum: "a".repeat(64),
    extraction: {
      version: "document-v1",
      sha256: "a".repeat(64),
      tables: [],
      blocks: [{ locator: "page:1", page: 1, text: "Максимальный ток MMA: 160 А" }],
      warnings: [],
      coverage: { complete: true },
    },
  };
  mocks.tg.mockImplementation(async () => Response.json({ ok: true, result: { message_id: 901 } }));
  mocks.from.mockImplementation((table) => {
    if (table !== "staff") throw new Error("UNEXPECTED_SEARCH_OR_EDITOR_ACCESS");
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: member, error: null }),
    };
    return q;
  });
  mocks.rpc.mockImplementation(async (name, args) => {
    if (fail === name + ":" + args.p_op)
      return { data: null, error: { message: "PRIVATE DATABASE DETAIL" } };
    if (name === "bot_product_sources") return { data: structuredClone(sourceData), error: null };
    if (name === "bot_document_intake") return { data: structuredClone(documentData), error: null };
    if (name !== "bot_source_fact_review") throw new Error("UNEXPECTED_RPC");
    if (override !== undefined) return { data: structuredClone(override), error: null };
    if (args.p_op === "input" && !stored?.prompt)
      return { data: { ok: true, idle: true }, error: null };
    if (args.p_op === "current" && !stored) return { data: { ok: true, idle: true }, error: null };
    if (args.p_op === "get" && (!stored || stored.review.id !== args.p_id))
      return { data: null, error: { message: "SOURCE_FACT_NOT_FOUND" } };
    if (args.p_op === "prepare") {
      stored = fixture();
      stored.review.id = args.p_id;
    }
    const v = stored!;
    if (args.p_op === "prompt") {
      v.review.revision++;
      v.prompt = {
        actor: 101,
        review_id: v.review.id,
        revision: v.review.revision,
        row_index: args.p_index,
        field: args.p_payload.field,
        message_id: null,
        expires_at: v.review.expires_at,
      };
    }
    if (args.p_op === "bind") v.prompt!.message_id = args.p_payload.message_id;
    if (args.p_op === "reply") {
      v.row!.draft!.value = args.p_payload.value;
      v.review.revision++;
      v.prompt = null;
    }
    if (args.p_op === "cancel_input") {
      v.review.revision++;
      v.prompt = null;
    }
    if (args.p_op === "handoff") {
      v.review.phase = "handed";
      v.review.revision++;
      v.review.editor_session_id = docId;
    }
    if (args.p_op === "accept") {
      v.row!.decision = "accepted";
      v.review.revision++;
      v.counts.pending = 0;
      v.counts.accepted = 1;
      v.next_pending = null;
    }
    return { data: structuredClone(v), error: null };
  });
});
afterEach(() => vi.unstubAllEnvs());

it.each([
  [{ ...member, role: "seller" as const }, chat, from],
  [{ ...member, role: "director" as const }, chat, from],
  [{ ...member, active: false }, chat, from],
  [member, { id: -1, type: "group" }, from],
  [member, chat, { id: 102 }],
])(
  "Checks actual sender/private chat/current permissions before service access",
  async (m, c, f) => {
    await showSourceFactReview(m, c, f, "sf:current");
    expect(await sourceFactControl(m, c, f, "resume")).toBe(false);
    expect(await handleSourceFactText(m, c, f, "170", 900)).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.tg).not.toHaveBeenCalled();
  },
);
it("Reads current persisted rows even from old read-only buttons", async () => {
  await showSourceFactReview(member, chat, from, sourceFactButton({ id, revision: 0 }, "row"));
  expect(calls()).toEqual(["bot_source_fact_review:get"]);
  expect(texts()).toContain("160 А");
});
function readyHandoff() {
  const v = stored!;
  v.handoff_supported = true;
  v.retained_sources = { usable: true, total: 0, unavailable: 0 };
  v.review.phase = "preview";
  v.review.publisher = "Учебный";
  v.review.preview_expires_at = new Date(Date.now() + 900000).toISOString();
  v.row!.decision = "accepted";
  v.counts = { total: 1, pending: 0, accepted: 1, skipped: 0 };
  v.next_pending = null;
  v.review.prepared_document = {
    family_code: "power_mma",
    sources: [
      {
        key: "document_0",
        kind: "manual",
        publisher: "Учебный",
        model: "QA-160",
        title: "Паспорт",
        url: "",
        sha256: "a".repeat(64),
        locator: "Страница 1",
        checked_on: "2026-11-07",
      },
    ],
    values: [{ ...v.row!.draft!, process: "mma", state: "known", source_key: "document_0" }],
  };
  v.review.merge_preview = {
    version: "source-fact-merge-v1",
    before_revision: null,
    before_document: null,
    after_document: structuredClone(v.review.prepared_document),
    changes: [{ kind: "added", before_index: null, after_index: 0 }],
  };
  return v;
}
it("Shows the explicit handoff confirmation without a mutation", async () => {
  readyHandoff();
  await showSourceFactReview(member, chat, from, sourceFactButton(stored!.review, "askhandoff"));
  expect(calls()).toEqual(["bot_source_fact_review:get"]);
  expect(texts()).toContain("Создастся один черновик");
  expect(texts()).toContain("отдельный предпросмотр и подтверждение");
});
it("Transfers once and recovers the exact original editor from an old confirmation", async () => {
  readyHandoff();
  const button = sourceFactButton(stored!.review, "handoff");
  await showSourceFactReview(member, chat, from, button);
  expect(calls()).toEqual(["bot_source_fact_review:get", "bot_source_fact_review:handoff"]);
  expect(mocks.rpc.mock.calls.at(-1)![1].p_payload).toEqual({
    confirm_plan: true,
    replace_family: false,
  });
  expect(stored!.review.editor_session_id).toBe(docId);
  await showSourceFactReview(member, chat, from, button);
  expect(calls().filter((c) => c.endsWith(":handoff"))).toHaveLength(1);
  expect(JSON.stringify(mocks.tg.mock.calls)).toContain("te:" + docId + ":0:resume");
});
it("Makes family replacement explicit in the final label and backend consent", async () => {
  const v = readyHandoff();
  v.review.merge_preview!.before_document = {
    family_code: "power_tig_dc",
    sources: [],
    values: [],
  };
  v.review.merge_preview!.before_revision = source;
  await showSourceFactReview(member, chat, from, sourceFactButton(v.review, "askhandoff"));
  expect(JSON.stringify(mocks.tg.mock.calls)).toContain("Да, заменить подборку");
  await showSourceFactReview(member, chat, from, sourceFactButton(v.review, "handoff"));
  expect(mocks.rpc.mock.calls.at(-1)![1].p_payload).toEqual({
    confirm_plan: true,
    replace_family: true,
  });
});
it("Recovers a committed handoff after losing the response without repeating it", async () => {
  readyHandoff();
  const button = sourceFactButton(stored!.review, "handoff");
  const original = mocks.rpc.getMockImplementation()!;
  mocks.rpc.mockImplementation(async (...args) => {
    const result = await original(...args);
    return args[1].p_op === "handoff"
      ? { data: null, error: { message: "PRIVATE_AFTER_COMMIT" } }
      : result;
  });
  await showSourceFactReview(member, chat, from, button);
  expect(stored!.review.phase).toBe("handed");
  expect(texts()).not.toContain("PRIVATE_AFTER_COMMIT");
  await showSourceFactReview(member, chat, from, button);
  expect(calls().filter((c) => c.endsWith(":handoff"))).toHaveLength(1);
  expect(JSON.stringify(mocks.tg.mock.calls)).toContain("te:" + docId + ":0:resume");
});
it("Refuses handoff when the installed backend does not advertise support", async () => {
  readyHandoff().handoff_supported = false;
  await showSourceFactReview(member, chat, from, sourceFactButton(stored!.review, "handoff"));
  expect(calls()).toEqual(["bot_source_fact_review:get"]);
});
it("Does not reopen a different merge position from an older preview button", async () => {
  await showSourceFactReview(
    member,
    chat,
    from,
    sourceFactButton({ id, revision: 3 }, "changes", 0, 0),
  );
  expect(calls()).toEqual(["bot_source_fact_review:get"]);
  expect(texts()).toContain("прежнему шагу");
});
it("Refuses stale mutation buttons before making a write", async () => {
  await showSourceFactReview(member, chat, from, sourceFactButton({ id, revision: 3 }, "accept"));
  expect(calls()).toEqual(["bot_source_fact_review:get"]);
  expect(texts()).toContain("прежнему шагу");
});
it.each(["actor", "id"] as const)("Does not expose a mismatched returned %s", async (field) => {
  if (field === "actor") stored!.review.actor = 102;
  else stored!.review.id = source;
  override = stored;
  await showSourceFactReview(member, chat, from, sourceFactButton({ id, revision: 4 }, "row"));
  expect(texts()).not.toContain("QA-160");
  expect(texts()).toContain("Не удалось прочитать результат");
});
it.each([undefined, 899, 901])(
  "Rejects a reply to the wrong question (%s) without a write",
  async (reply) => {
    pending();
    expect(await handleSourceFactText(member, chat, from, "170", reply)).toBe(true);
    expect(calls()).toEqual(["bot_source_fact_review:input"]);
    expect(stored!.row!.draft!.value).toBe(160);
    expect(questions()).toHaveLength(0);
  },
);
it("Parses the answer, keeps its exact question binding, and never approves automatically", async () => {
  pending();
  await handleSourceFactText(member, chat, from, "170,5", 900);
  expect(mocks.rpc).toHaveBeenLastCalledWith(
    "bot_source_fact_review",
    expect.objectContaining({
      p_actor: 101,
      p_op: "reply",
      p_id: id,
      p_revision: 4,
      p_index: 0,
      p_payload: { reply_to: 900, value: 170.5 },
    }),
  );
  expect(stored!.row!.decision).toBe("pending");
  expect(stored!.row!.proposal.evidence).toMatchObject({ quote: "Максимальный ток MMA: 160 А" });
});
it("Recovers a committed reply after its response is lost without repeating the write", async () => {
  pending();
  const original = mocks.rpc.getMockImplementation()!;
  mocks.rpc.mockImplementation(async (...args) => {
    const result = await original(...args);
    return args[1].p_op === "reply"
      ? { data: null, error: { message: "PRIVATE_AFTER_COMMIT" } }
      : result;
  });
  await handleSourceFactText(member, chat, from, "175", 900);
  expect(stored!.row!.draft!.value).toBe(175);
  expect(stored!.prompt).toBeNull();
  expect(texts()).not.toContain("PRIVATE");
  const recovery = mocks.tg.mock.calls.at(-1)![1].reply_markup.inline_keyboard[0][0].callback_data;
  await showSourceFactReview(member, chat, from, recovery);
  expect(calls()).toEqual([
    "bot_source_fact_review:input",
    "bot_source_fact_review:reply",
    "bot_source_fact_review:get",
  ]);
  expect(questions()).toHaveLength(0);
  expect(texts()).toContain("175 А");
});
it("Keeps the same question after invalid input and does not silently resend it", async () => {
  pending();
  await handleSourceFactText(member, chat, from, "170 кА", 900);
  expect(calls()).toEqual(["bot_source_fact_review:input"]);
  expect(stored!.prompt!.message_id).toBe(900);
  expect(questions()).toHaveLength(0);
  expect(texts()).toContain("без единицы измерения");
});
it("Only an explicit resume creates a new question revision and binds the actual delivered message", async () => {
  pending();
  expect(await sourceFactControl(member, chat, from, "resume")).toBe(true);
  expect(calls()).toEqual([
    "bot_source_fact_review:input",
    "bot_source_fact_review:prompt",
    "bot_source_fact_review:bind",
  ]);
  expect(stored!.prompt).toMatchObject({ revision: 5, message_id: 901 });
  expect(questions()).toHaveLength(1);
  expect(questions()[0]![1].text).toContain("Публикация не начнётся");
});
it("Keeps an unbound question after an unknown Telegram delivery without a hidden retry", async () => {
  pending();
  mocks.tg.mockRejectedValueOnce(new Error("UNKNOWN_DELIVERY"));
  await expect(sourceFactControl(member, chat, from, "resume")).rejects.toThrow("UNKNOWN_DELIVERY");
  expect(calls()).toEqual(["bot_source_fact_review:input", "bot_source_fact_review:prompt"]);
  expect(stored!.prompt!.message_id).toBeNull();
  expect(questions()).toHaveLength(1);
});
it("Offers read/recovery after an uncertain bind without sending a second question", async () => {
  pending();
  fail = "bot_source_fact_review:bind";
  await sourceFactControl(member, chat, from, "resume");
  expect(questions()).toHaveLength(1);
  expect(stored!.prompt!.message_id).toBeNull();
  expect(texts()).not.toContain("PRIVATE");
  expect(texts()).toContain("прочитайте сохранённый разбор");
});
it("Cancels only the current input and preserves the saved draft", async () => {
  pending();
  const draft = structuredClone(stored!.row!.draft);
  await sourceFactControl(member, chat, from, "cancel");
  expect(calls()).toEqual(["bot_source_fact_review:input", "bot_source_fact_review:cancel_input"]);
  expect(stored!.prompt).toBeNull();
  expect(stored!.row!.draft).toEqual(draft);
  expect(stored!.review.phase).toBe("reviewing");
});
it.each([null, { ok: true }, { ok: true, idle: true, unexpected: "data" }])(
  "Does not treat malformed input state as idle (%s)",
  async (value) => {
    override = value;
    expect(await handleSourceFactText(member, chat, from, "Название товара")).toBe(true);
    expect(texts()).toContain("Не удалось прочитать результат");
    expect(mocks.from).not.toHaveBeenCalled();
  },
);
it("A read failure consumes no answer and does not fall through to product search in the real dispatcher", async () => {
  pending();
  fail = "bot_source_fact_review:input";
  await handleUpdate({
    update_id: 10,
    message: { message_id: 80, from, chat, text: "170", reply_to_message: { message_id: 900 } },
  });
  expect(calls()).toEqual(["bot_source_fact_review:input"]);
  expect(stored!.row!.draft!.value).toBe(160);
  expect(mocks.from.mock.calls.map(([table]) => table)).toEqual(["staff"]);
  expect(texts()).not.toContain("PRIVATE");
});
it.each(["/input", "/cancel"])(
  "Dispatcher %s does not close another editor after a failed source-question read",
  async (text) => {
    pending();
    fail = "bot_source_fact_review:input";
    await handleUpdate({ update_id: 10, message: { message_id: 80, from, chat, text } });
    expect(calls()).toEqual(["bot_source_fact_review:input"]);
    expect(stored!.prompt!.message_id).toBe(900);
    expect(mocks.from.mock.calls.map(([table]) => table)).toEqual(["staff"]);
  },
);
it("Rejects an unconfirmed bind response and does not resend the question", async () => {
  pending();
  const original = mocks.rpc.getMockImplementation()!;
  mocks.rpc.mockImplementation(async (...args) => {
    const result = await original(...args);
    if (args[1].p_op === "bind") result.data.prompt = null;
    return result;
  });
  await sourceFactControl(member, chat, from, "resume");
  expect(questions()).toHaveLength(1);
  expect(texts()).toContain("Не удалось прочитать результат");
});
it("Dispatcher routes the callback to the saved row, preserving stable request identity", async () => {
  await handleUpdate({
    update_id: 10,
    callback_query: {
      id: "cb",
      from,
      message: { message_id: 80, chat },
      data: sourceFactButton({ id, revision: 4 }, "row"),
    },
  });
  expect(calls()).toEqual(["bot_source_fact_review:get"]);
  expect(mocks.tg.mock.calls.some(([method]) => method === "answerCallbackQuery")).toBe(true);
  expect(texts()).toContain("160 А");
});
it("Dispatcher /input and /cancel handle the source question before other editors", async () => {
  pending();
  await handleUpdate({ update_id: 10, message: { message_id: 80, from, chat, text: "/input" } });
  await handleUpdate({ update_id: 11, message: { message_id: 81, from, chat, text: "/cancel" } });
  expect(calls().every((call) => call.startsWith("bot_source_fact_review:"))).toBe(true);
  expect(stored!.prompt).toBeNull();
});
it("Does not repeat a completed acceptance when sending its response fails", async () => {
  mocks.tg.mockRejectedValueOnce(new Error("UNKNOWN_DELIVERY"));
  await expect(
    showSourceFactReview(member, chat, from, sourceFactButton({ id, revision: 4 }, "accept")),
  ).rejects.toThrow("UNKNOWN_DELIVERY");
  expect(stored!.row!.decision).toBe("accepted");
  expect(calls()).toEqual(["bot_source_fact_review:get", "bot_source_fact_review:accept"]);
  await showSourceFactReview(member, chat, from, sourceFactButton({ id, revision: 4 }, "row"));
  expect(calls().filter((s) => s.endsWith(":accept"))).toHaveLength(1);
});
const start = () =>
  sourceFactFamilyButton(
    sourceReview,
    5,
    families.findIndex((f) => f.code === "power_mma"),
    true,
  );
it("Repeated start reads its receipt without loading the source or running extraction again", async () => {
  stored!.usable = false;
  await showSourceFactReview(member, chat, from, start(), id);
  expect(calls()).toEqual(["bot_source_fact_review:get"]);
  expect(texts()).toContain("Сохранённые решения нельзя применить");
});
it("Prepares from the exact actor-owned approved document after an explicit family choice", async () => {
  stored = null;
  await showSourceFactReview(member, chat, from, start(), id);
  expect(calls()).toEqual([
    "bot_source_fact_review:get",
    "bot_product_sources:get",
    "bot_document_intake:get",
    "bot_source_fact_review:prepare",
  ]);
  const payload = mocks.rpc.mock.calls.at(-1)![1].p_payload;
  expect(payload.source_id).toBe(source);
  expect(payload.result.family_code).toBe("power_mma");
  expect(payload.result.checksum).toBe("a".repeat(64));
  expect(payload.result.candidates[0].evidence.quote).toBe("Максимальный ток MMA: 160 А");
});
it.each(["revision", "model", "source", "checksum"] as const)(
  "Rejects changed %s before preparing a review",
  async (part) => {
    stored = null;
    const r = sourceData["review"] as Record<string, unknown>;
    if (part === "revision") r["revision"] = 6;
    if (part === "model") r["model_matches"] = false;
    if (part === "source") r["usable"] = false;
    if (part === "checksum") documentData["checksum"] = "b".repeat(64);
    await showSourceFactReview(member, chat, from, start(), id);
    expect(calls()).not.toContain("bot_source_fact_review:prepare");
  },
);
it("Does not create another review after an unknown result of receipt reading", async () => {
  stored = null;
  fail = "bot_source_fact_review:get";
  await showSourceFactReview(member, chat, from, start(), id);
  expect(calls()).toEqual(["bot_source_fact_review:get"]);
  expect(texts()).not.toContain("PRIVATE");
});
it("Does not invent rows when extraction found none", async () => {
  stored = null;
  (documentData["extraction"] as Record<string, unknown>)["blocks"] = [];
  await showSourceFactReview(member, chat, from, start(), id);
  expect(calls()).not.toContain("bot_source_fact_review:prepare");
  expect(texts()).toContain("Не удалось выделить строки");
});
it("Refuses a new start without the stable dispatcher request ID", async () => {
  await showSourceFactReview(member, chat, from, start());
  expect(mocks.rpc).not.toHaveBeenCalled();
});
