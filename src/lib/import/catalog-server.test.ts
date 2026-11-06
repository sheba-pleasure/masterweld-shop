import { beforeEach, expect, it, vi } from "vitest";
import type { StaffMember } from "@/lib/bot/permissions";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), tg: vi.fn(), download: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
vi.mock("@/lib/bot/telegram.server", async (original) => ({
  ...(await original<typeof import("@/lib/bot/telegram.server")>()),
  tg: mocks.tg,
}));
vi.mock("./telegram-file.server", () => ({ downloadCatalogDocument: mocks.download }));
import { showCatalogImport, receiveCatalogDocument } from "./catalog.server";
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
it("an uneditable Telegram response never replays the applied transaction", async () => {
  mocks.tg
    .mockRejectedValueOnce(new TelegramDeliveryError("http", false, 400))
    .mockResolvedValue({});
  await showCatalogImport(admin, chat, { op: "apply", id: "batch", revision: 1 }, 55);
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
  expect(mocks.tg.mock.calls.map((c) => c[0])).toEqual(["editMessageText", "sendMessage"]);
});
it("temporary delivery failure propagates without another database operation", async () => {
  mocks.tg.mockRejectedValueOnce(new TelegramDeliveryError("network", true));
  await expect(
    showCatalogImport(admin, chat, { op: "apply", id: "batch", revision: 1 }, 55),
  ).rejects.toThrow();
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
  expect(mocks.tg).toHaveBeenCalledTimes(1);
});
