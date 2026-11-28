import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { CATALOG_TEMPLATE } from "./catalog-template";
import type { StaffMember } from "@/lib/bot/permissions";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), tg: vi.fn(), download: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
vi.mock("@/lib/bot/telegram.server", async (original) => ({
  ...(await original<typeof import("@/lib/bot/telegram.server")>()),
  tg: mocks.tg,
}));
vi.mock("./telegram-file.server", () => ({ downloadCatalogDocument: mocks.download }));
import { showCatalogImport, receiveCatalogDocument } from "./catalog.server";
import { parseImportCallback } from "./catalog-view";
import { TelegramDeliveryError } from "@/lib/bot/telegram.server";
const admin: StaffMember = {
  telegram_id: 101,
  name: "QA",
  role: "admin",
  elevated: false,
  active: true,
};
const chat = { id: 101, type: "private" };
const home = { ok: true, home: true, recent: [] };
it("sends the same downloadable CSV as an uploaded document without importing it", async () => {
  await showCatalogImport(admin, chat, { op: "template" });
  const [method, form] = mocks.tg.mock.calls[0]!;
  expect(method).toBe("sendDocument");
  expect(form).toBeInstanceOf(FormData);
  const content = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsText(form.get("document"));
  });
  expect(content).toBe(CATALOG_TEMPLATE);
  expect(CATALOG_TEMPLATE).toBe(readFileSync("public/import-template.csv", "utf8"));
  expect(mocks.rpc).not.toHaveBeenCalled();
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: home, error: null });
  mocks.tg.mockResolvedValue({});
  mocks.download.mockResolvedValue(new TextEncoder().encode("sku;price\nA;10"));
});
it("denies raw file access for sellers and forged private chats", async () => {
  await receiveCatalogDocument(
    { ...admin, role: "seller" },
    chat,
    { file_name: "a.csv", file_id: "secret" },
    1,
  );
  await receiveCatalogDocument(
    admin,
    { id: 202, type: "private" },
    { file_name: "a.csv", file_id: "secret" },
    1,
  );
  await showCatalogImport({ ...admin, active: false }, chat, { op: "home" });
  expect(mocks.download).not.toHaveBeenCalled();
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it("stores source and configuration without applying anything on upload", async () => {
  await receiveCatalogDocument(admin, chat, { file_name: "a.csv", file_id: "secret" }, 1);
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(
    "bot_catalog_import",
    expect.objectContaining({
      p_actor: 101,
      p_op: "upload",
      p_payload: expect.objectContaining({
        request_key: "1",
        checksum: expect.stringMatching(/^[0-9a-f]{64}$/),
        source: { header: ["sku", "price"], rows: [["A", "10"]] },
      }),
    }),
  );
  expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain("secret");
});
it("stale mapping confirmation never generates a preview", async () => {
  mocks.rpc.mockResolvedValue({ data: { ok: true, revision: 2 }, error: null });
  await showCatalogImport(admin, chat, { op: "preview", id: "batch", revision: 1 });
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
  expect(mocks.rpc.mock.calls[0]![1].p_op).toBe("source");
  expect(mocks.tg.mock.calls[0]![1].text).toContain("Настройки изменились");
});
it("unknown database outcome never claims unchanged data or exposes errors", async () => {
  mocks.rpc.mockRejectedValue(new Error("SERVICE_ROLE_SECRET"));
  await showCatalogImport(admin, chat, { op: "apply", id: "batch", revision: 1 });
  expect(mocks.tg.mock.calls[0]![1].text).toContain("Результат не подтверждён");
  expect(JSON.stringify(mocks.tg.mock.calls)).not.toContain("SERVICE_ROLE_SECRET");
});
it.each(["apply", "undo", "map"])(
  "recovers uncertain %s through get, never mutation replay",
  async (op) => {
    const id = "11111111-1111-4111-8111-111111111111";
    mocks.rpc.mockRejectedValueOnce(new Error("PRIVATE_DB_ERROR"));
    await showCatalogImport(admin, chat, { op, id, revision: 1, field: 3, column: 2 });
    const message = mocks.tg.mock.calls[0]![1];
    expect(message.text).toContain("Результат не подтверждён");
    expect(message.text).not.toContain("PRIVATE_DB_ERROR");
    const buttons = message.reply_markup.inline_keyboard.flat();
    expect(
      buttons.map((b: { callback_data: string }) => parseImportCallback(b.callback_data)?.op),
    ).toEqual(["get", "home"]);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    const recovery = parseImportCallback(buttons[0].callback_data);
    await showCatalogImport(admin, chat, recovery);
    expect(mocks.rpc.mock.calls.map((c) => c[1].p_op)).toEqual([op, "get"]);
    expect(mocks.rpc.mock.calls[1]![1].p_id).toBe(id);
    mocks.rpc.mockClear();
    for (const [actor, target] of [
      [{ ...admin, role: "seller" as const }, chat],
      [{ ...admin, active: false }, chat],
      [admin, { id: 202, type: "private" }],
      [admin, { id: 101, type: "group" }],
    ] as const)
      await showCatalogImport(actor, target, recovery);
    expect(mocks.rpc).not.toHaveBeenCalled();
  },
);
it("upload failure offers saved imports and document intake without retrying upload", async () => {
  mocks.rpc.mockRejectedValueOnce(new Error("PRIVATE_DB_ERROR"));
  await receiveCatalogDocument(admin, chat, { file_name: "a.csv", file_id: "secret" }, 1);
  const message = mocks.tg.mock.calls[0]![1];
  expect(message.text).toContain("Результат не подтверждён");
  expect(
    message.reply_markup.inline_keyboard
      .flat()
      .map((b: { callback_data: string }) => b.callback_data),
  ).toEqual(["ci:home", "di:home"]);
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
  expect(mocks.download).toHaveBeenCalledTimes(1);
});
it("an uneditable Telegram response never replays the applied transaction", async () => {
  mocks.tg
    .mockRejectedValueOnce(new TelegramDeliveryError("http", false, 400))
    .mockResolvedValue({});
  await showCatalogImport(admin, chat, { op: "apply", id: "batch", revision: 1 }, 55);
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
  expect(mocks.tg.mock.calls.map((c) => c[0])).toEqual(["editMessageText", "sendMessage"]);
});
it("passes only the explicit inquiry choice and original revision to the owned RPC", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  await showCatalogImport(admin, chat, { op: "inquiry_price", id, revision: 7, enabled: true });
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("bot_catalog_import", {
    p_actor: 101,
    p_op: "inquiry_price",
    p_id: id,
    p_page: 0,
    p_revision: 7,
    p_payload: { enabled: true },
  });
  mocks.rpc.mockClear();
  await showCatalogImport({ ...admin, role: "seller" }, chat, {
    op: "inquiry_price",
    id,
    revision: 7,
    enabled: true,
  });
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it("temporary delivery failure propagates without another database operation", async () => {
  mocks.tg.mockRejectedValueOnce(new TelegramDeliveryError("network", true));
  await expect(
    showCatalogImport(admin, chat, { op: "apply", id: "batch", revision: 1 }, 55),
  ).rejects.toThrow();
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
  expect(mocks.tg).toHaveBeenCalledTimes(1);
});
