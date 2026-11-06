import { beforeEach, expect, it, vi } from "vitest";
import type { StaffMember } from "./permissions";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), tg: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
vi.mock("./telegram.server", async (original) => ({
  ...(await original<typeof import("./telegram.server")>()),
  tg: mocks.tg,
}));
import { TelegramDeliveryError } from "./telegram.server";
import { showAssortment } from "./assortment.server";
const admin: StaffMember = {
  telegram_id: 101,
  name: "QA",
  role: "admin",
  active: true,
  elevated: false,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({
    data: { ok: true, home: true, counts: {}, recent: [] },
    error: null,
  });
  mocks.tg.mockResolvedValue({});
});
it("edits the current Telegram message after a single RPC", async () => {
  await showAssortment(admin, { id: 101, type: "private" }, { p_op: "home" }, 42);
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("bot_assortment", {
    p_op: "home",
    p_staff_telegram_id: 101,
  });
  expect(mocks.tg).toHaveBeenCalledWith(
    "editMessageText",
    expect.objectContaining({ message_id: 42, chat_id: 101 }),
  );
});
it("never repeats a database mutation when an old message cannot be edited", async () => {
  mocks.tg
    .mockRejectedValueOnce(new TelegramDeliveryError("http", false, 400))
    .mockResolvedValue({});
  await showAssortment(
    admin,
    { id: 101, type: "private" },
    { p_op: "apply", p_batch_id: "test" },
    42,
  );
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
  expect(mocks.tg.mock.calls.map((c) => c[0])).toEqual(["editMessageText", "sendMessage"]);
});
it("delivery network failure is propagated without replaying a committed operation", async () => {
  mocks.tg.mockRejectedValueOnce(new TelegramDeliveryError("network", true));
  await expect(
    showAssortment(admin, { id: 101, type: "private" }, { p_op: "apply" }, 42),
  ).rejects.toThrow();
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
  expect(mocks.tg).toHaveBeenCalledTimes(1);
});
it("an unknown RPC outcome says to inspect saved state", async () => {
  mocks.rpc.mockRejectedValueOnce(new Error("PRIVATE_DETAIL"));
  await showAssortment(admin, { id: 101, type: "private" }, { p_op: "apply" });
  expect(mocks.tg.mock.calls[0][1].text).toContain("не подтверждён");
  expect(JSON.stringify(mocks.tg.mock.calls)).not.toContain("PRIVATE_DETAIL");
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
});
it("rejects a seller or wrong private-chat identity before service access", async () => {
  await showAssortment(
    { ...admin, role: "seller" },
    { id: 101, type: "private" },
    { p_op: "home" },
  );
  await showAssortment(admin, { id: 102, type: "private" }, { p_op: "home" });
  expect(mocks.rpc).not.toHaveBeenCalled();
});
