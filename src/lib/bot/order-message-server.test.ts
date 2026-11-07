import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ tg: vi.fn() }));
vi.mock("./telegram.server", async (original) => ({
  ...(await original<typeof import("./telegram.server")>()),
  tg: mocks.tg,
}));
import { TelegramDeliveryError } from "./telegram.server";
import { showOrderMessage } from "./order-message.server";

const view = {
  text: "Статус: в обработке",
  rows: [[{ text: "К списку", callback_data: "orders:0" }]],
};
beforeEach(() => {
  mocks.tg.mockReset().mockResolvedValue(undefined);
});

it("does not duplicate a card whose identical contents are already present", async () => {
  mocks.tg.mockRejectedValue(new TelegramDeliveryError("http", false, 400, undefined, true));
  await showOrderMessage(101, view, 41);
  expect(mocks.tg).toHaveBeenCalledTimes(1);
});
it("replaces an uneditable card once and clearly identifies the current card", async () => {
  mocks.tg.mockRejectedValueOnce(new TelegramDeliveryError("http", false, 400));
  await showOrderMessage(101, view, 41);
  expect(mocks.tg.mock.calls.map((c) => c[0])).toEqual(["editMessageText", "sendMessage"]);
  expect(mocks.tg).toHaveBeenNthCalledWith(
    2,
    "sendMessage",
    expect.objectContaining({ text: expect.stringContaining("Используйте эту.") }),
  );
  expect(mocks.tg).toHaveBeenNthCalledWith(
    2,
    "sendMessage",
    expect.objectContaining({ text: expect.stringContaining(view.text) }),
  );
});
it.each([
  new TelegramDeliveryError("network", true),
  new TelegramDeliveryError("http", true, 503),
  new TelegramDeliveryError("http", true, 429, 60),
  new TelegramDeliveryError("http", false, 403),
  new TelegramDeliveryError("protocol", false, 200),
])("does not send a second message after uncertain/forbidden delivery: %j", async (error) => {
  mocks.tg.mockRejectedValue(error);
  await expect(showOrderMessage(101, view, 41)).rejects.toBe(error);
  expect(mocks.tg).toHaveBeenCalledTimes(1);
});
it("sends once when an old callback does not include a usable message ID", async () => {
  await showOrderMessage(101, view);
  expect(mocks.tg).toHaveBeenCalledExactlyOnceWith("sendMessage", {
    chat_id: 101,
    text: view.text,
    reply_markup: { inline_keyboard: view.rows },
  });
});
