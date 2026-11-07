import { beforeEach, expect, it, vi } from "vitest";
import {
  modelLinkState,
  parseProductModelCallback,
  renderProductModelLinks,
  type DocumentModelLink,
  type ProductModelLinks,
} from "./model-links-view";
import { renderImport, type ImportView } from "./catalog-view";
import { buildProductCardBot } from "@/lib/bot/catalog";
import type { StaffMember } from "@/lib/bot/permissions";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), tg: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
vi.mock("@/lib/bot/telegram.server", async (original) => ({
  ...(await original<typeof import("@/lib/bot/telegram.server")>()),
  tg: mocks.tg,
}));
import { showProductModelLinks } from "./model-links.server";
import { showCatalogImport } from "./catalog.server";
const id = "11111111-1111-4111-8111-111111111111";
const admin: StaffMember = {
  telegram_id: 101,
  name: "QA",
  active: true,
  role: "admin",
  elevated: false,
};
const chat = { id: 101, type: "private" };
const link: DocumentModelLink = {
  review_id: id,
  row: 4999,
  model_revision: 2,
  decision_id: id,
  identity: { manufacturer: "Изготовитель", model: "aB-220", variant_mode: "none", variant: "" },
  state: "linked",
  product_id: id,
  document_id: id,
  file_name: "Прайс.tsv",
  linked_at: "2026-11-07T01:00:00Z",
  import_id: id,
  line: 2,
};
const product: ProductModelLinks = {
  ok: true,
  product_id: id,
  title: "Аппарат",
  sku: "aB-001",
  items: [link],
  page: 0,
  pages: 1,
  conflicting: false,
  excluded: false,
};
const batch: ImportView = {
  ok: true,
  id,
  file: "Прайс.tsv",
  state: "preview",
  revision: 3,
  header: ["sku", "price"],
  sample: ["aB-001", "10"],
  mapping: {
    sku: 0,
    price: 1,
    title: -1,
    brand: -1,
    cost_price: -1,
    category_slug: -1,
    in_stock: -1,
    stock_qty: -1,
  },
  decimal: "comma",
  fileRows: 1,
  counts: { new: 0, update: 0, unchanged: 1, error: 0, excluded: 0 },
  page: 0,
  pages: 1,
  model_count: 1,
  document_review_id: id,
  items: [
    {
      line: 2,
      sku: "aB-001",
      kind: "unchanged",
      errors: [],
      patch: { price: 10 },
      before_product: { title: "Аппарат", price: 10 },
      after_product: { title: "Аппарат", price: 10 },
      before_cost: null,
      after_cost: null,
      document_model: link,
    },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: product, error: null });
  mocks.tg.mockResolvedValue({});
});
it("reads only after private actor and import rights checks", async () => {
  for (const [m, c] of [
    [{ ...admin, role: "seller" as const }, chat],
    [{ ...admin, active: false }, chat],
    [admin, { id: 202, type: "private" }],
    [admin, { id: 101, type: "group" }],
  ] as const)
    await showProductModelLinks(m, c, `mp:${id}:0`);
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.tg).not.toHaveBeenCalled();
  await showProductModelLinks(admin, chat, `mp:${id}:0`);
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("bot_product_document_models", {
    p_actor: 101,
    p_product: id,
    p_page: 0,
  });
});
it("distinguishes failed source reads from an empty source list and never replays writes", async () => {
  mocks.rpc.mockResolvedValue({ data: null, error: { message: "PRIVATE_DB_DETAILS" } });
  await showProductModelLinks(admin, chat, `mp:${id}:0`);
  const text = mocks.tg.mock.calls[0]![1].text;
  expect(text).toContain("Это не означает, что их нет");
  expect(text).not.toContain("PRIVATE_DB_DETAILS");
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
  expect(renderProductModelLinks({ ...product, items: [] }).text).toContain(
    "Связей с вашими документами пока нет",
  );
});
it("shows conflicts, exclusion and historical decisions without automatic model selection", () => {
  const r = {
    ...product,
    conflicting: true,
    excluded: true,
    items: [link, { ...link, state: "undone" }, { ...link, state: "model_changed" }],
  };
  const v = renderProductModelLinks(r);
  expect(v.text).toContain("подтверждены разные модели");
  expect(v.text).toContain("Товар исключён");
  expect(v.text).toContain(modelLinkState["undone"]);
  expect(v.text).toContain(modelLinkState["model_changed"]);
  expect(v.text).toContain("aB-220");
  expect(v.rows.flat().every((b) => Buffer.byteLength(b.callback_data) <= 64)).toBe(true);
  expect(v.rows.flat().some((b) => /apply|confirm|publish/.test(b.callback_data))).toBe(false);
});
it("allows explicit model-only confirmation, with separate source and refresh buttons", () => {
  const v = renderImport(batch);
  expect(v.rows.flat().some((b) => b.text === "✅ Сохранить связи с моделями")).toBe(true);
  expect(v.rows.flat().some((b) => b.callback_data === `dm:${id}:0:get:4999`)).toBe(true);
  expect(v.rows.flat().some((b) => b.callback_data === `ci:preview:${id}:3`)).toBe(true);
  expect(v.text).toContain("Автопоиск и публикация не запускаются");
  for (const r of [
    { ...batch, model_count: 0 },
    { ...batch, counts: { ...batch.counts, error: 1 } },
  ])
    expect(
      renderImport(r)
        .rows.flat()
        .some((b) => b.callback_data.includes("ci:apply:")),
    ).toBe(false);
});
it("does not invent model provenance for historical imports", () => {
  const v = renderImport({ ...batch, model_capture_ready: false, model_count: 0 });
  expect(v.text).toContain("Обновите предпросмотр");
  expect(v.rows.flat().some((b) => b.callback_data.includes("ci:apply:"))).toBe(false);
  expect(renderImport({ ...batch, state: "applied", model_capture_ready: false }).text).toContain(
    "История не дополняется задним числом",
  );
});
it("recovers a changed model through read-only import navigation", async () => {
  mocks.rpc.mockResolvedValue({ data: null, error: { message: "IMPORT_MODEL_CHANGED" } });
  await showCatalogImport(admin, chat, { op: "apply", id, revision: 3 });
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
  expect(mocks.tg.mock.calls[0]![1].text).toContain("обновите предпросмотр");
  expect(mocks.tg.mock.calls[0]![1].reply_markup.inline_keyboard[0][0].callback_data).toBe(
    `ci:get:${id}:0`,
  );
});
it("delivers long import/model evidence in bounded messages with buttons on the final part", async () => {
  const long = {
    ...link,
    identity: {
      manufacturer: "И".repeat(100),
      model: "М".repeat(150),
      variant_mode: "specified",
      variant: "В".repeat(150),
    },
    file_name: "Ф".repeat(200),
  };
  mocks.rpc.mockResolvedValue({ data: { ...product, items: [long, long, long] }, error: null });
  await showProductModelLinks(admin, chat, `mp:${id}:0`);
  expect(mocks.tg.mock.calls.every((c) => Array.from(c[1].text).length <= 3500)).toBe(true);
  mocks.tg.mockClear();
  const huge = {
    ...batch,
    items: Array.from({ length: 3 }, () => ({
      ...batch.items[0]!,
      sku: "S".repeat(60),
      document_model: long,
      before_product: { title: "П".repeat(200), brand: "Д".repeat(100), price: 100000 },
      before_cost: { cost_price: 20 },
      after_cost: { cost_price: 11 },
      after_product: { title: "Т".repeat(200), price: 10 },
      patch: {
        price: 10,
        brand: "Б".repeat(100),
        title: "Т".repeat(200),
        category_slug: "К".repeat(120),
        stock_qty: 100,
        in_stock: true,
        cost_price: 9,
      },
    })),
  };
  mocks.rpc.mockResolvedValue({ data: huge, error: null });
  await showCatalogImport(admin, chat, { op: "get", id }, 700);
  const calls = mocks.tg.mock.calls;
  expect(calls.length).toBeGreaterThan(1);
  expect(calls.every((c) => c[0] === "sendMessage" && Array.from(c[1].text).length <= 3500)).toBe(
    true,
  );
  expect(calls.at(-1)![1].reply_markup.inline_keyboard.length).toBeGreaterThan(0);
  expect(calls.slice(0, -1).every((c) => !c[1].reply_markup)).toBe(true);
  expect(calls.map((c) => c[1].text).join("")).toContain("М".repeat(150));
});
it("only offers source documents to users with the explicit card capability", () => {
  const p = {
    id,
    slug: "a",
    title: "Аппарат",
    brand: null,
    sku: null,
    price: 10,
    old_price: null,
    in_stock: false,
    stock_qty: null,
    status: "draft",
    category_id: null,
  };
  expect(
    buildProductCardBot(p)
      .rows.flat()
      .some((b) => b.callback_data.startsWith("mp:")),
  ).toBe(false);
  expect(
    buildProductCardBot(p, { canReviewDocuments: true })
      .rows.flat()
      .some((b) => b.callback_data === `mp:${id}:0`),
  ).toBe(true);
});
it("rejects injected product/source callbacks and bounds pagination", () => {
  expect(parseProductModelCallback(`mp:${id}:1666`)?.page).toBe(1666);
  for (const value of [`mp:${id}:1667`, `mp:${id}:0:1`, "mp:../secret:0"])
    expect(parseProductModelCallback(value)).toBeNull();
});
