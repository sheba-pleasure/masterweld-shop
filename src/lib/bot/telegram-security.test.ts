import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tg, TelegramDeliveryError } from "./telegram.server";
import { processClaimedUpdate } from "./webhook-processing";
beforeEach(() => {
  vi.stubEnv("LOVABLE_API_KEY", "mock-secret");
  vi.stubEnv("TELEGRAM_API_KEY", "mock-token");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("Telegram typed safe failures", () => {
  it.each([
    [400, false],
    [401, false],
    [403, false],
    [429, true],
    [500, true],
    [503, true],
  ])("HTTP %i", async (status, temporary) => {
    const fetcher = vi.fn().mockResolvedValue(new Response("PRIVATE_PHONE mock-token", { status }));
    vi.stubGlobal("fetch", fetcher);
    await expect(tg("sendMessage", { text: "PRIVATE_PHONE" })).rejects.toMatchObject({
      kind: "http",
      temporary,
      status,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("PRIVATE_PHONE");
  });
  it.each([
    [400, false],
    [429, true],
    [500, true],
  ])("200 ok:false code %i", async (error_code, temporary) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(Response.json({ ok: false, error_code, description: "PRIVATE_PHONE" })),
    );
    await expect(tg("sendMessage", {})).rejects.toMatchObject({ kind: "api", temporary });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("PRIVATE_PHONE");
  });
  it("network exception is sanitised", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("mock-token PRIVATE_PHONE")));
    await expect(tg("sendMessage", {})).rejects.toMatchObject({
      kind: "network",
      temporary: true,
      message: "TELEGRAM_DELIVERY_FAILED",
    });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("mock-token");
  });
  it.each(["not JSON", "{}", '{"ok":"true"}'])(
    "malformed response %s fails closed",
    async (text) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(text)));
      await expect(tg("sendMessage", {})).rejects.toBeInstanceOf(TelegramDeliveryError);
    },
  );
  it("success preserves readable Response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ ok: true, result: { message_id: 1 } })),
    );
    expect(await (await tg("sendMessage", {})).json()).toEqual({
      ok: true,
      result: { message_id: 1 },
    });
  });
  it("configuration failure never fetches", async () => {
    vi.stubEnv("TELEGRAM_API_KEY", "");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(tg("sendMessage", {})).rejects.toMatchObject({
      kind: "configuration",
      temporary: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
describe("webhook claim retains uncertain mutations", () => {
  it.each([true, false])(
    "delivery failure temporary=%s cannot replay mutation",
    async (temporary) => {
      let claimed = false;
      const store = {
        claim: vi.fn(async () => {
          if (claimed) return { error: { code: "23505" } };
          claimed = true;
          return { error: null };
        }),
      };
      const handle = vi.fn(async () => {
        throw new TelegramDeliveryError("http", temporary, 503);
      });
      const first = await processClaimedUpdate(1, store, handle);
      expect(first.status).toBe(temporary ? 503 : 200);
      expect(await first.json()).toEqual({ ok: false, code: "REVIEW_REQUIRED" });
      const second = await processClaimedUpdate(1, store, handle);
      expect(second.status).toBe(200);
      expect(handle).toHaveBeenCalledTimes(1);
    },
  );
  it("claim failure never enters handler", async () => {
    const handle = vi.fn();
    const response = await processClaimedUpdate(
      1,
      { claim: async () => ({ error: { code: "XX000" } }) },
      handle,
    );
    expect(response.status).toBe(503);
    expect(handle).not.toHaveBeenCalled();
  });
  it("unknown error sanitised and retained", async () => {
    const response = await processClaimedUpdate(
      1,
      { claim: async () => ({ error: null }) },
      async () => {
        throw new Error("PRIVATE_PHONE");
      },
    );
    expect(response.status).toBe(503);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("PRIVATE_PHONE");
  });
  it("successful processing returns ok", async () => {
    const response = await processClaimedUpdate(
      1,
      { claim: async () => ({ error: null }) },
      async () => {},
    );
    expect(await response.json()).toEqual({ ok: true });
  });
});
