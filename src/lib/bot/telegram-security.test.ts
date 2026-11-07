import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tg, TelegramDeliveryError } from "./telegram.server";
import { processClaimedUpdate } from "./webhook-processing";
beforeEach(() => {
  vi.stubEnv("TELEGRAM_TRANSPORT", "direct");
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "12345:abcdefghijklmnopqrstuvwxyz");
  vi.stubEnv("TELEGRAM_BOT_ID", "12345");
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "s".repeat(40));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("Telegram typed safe failures", () => {
  it.each([200, 400])(
    "classifies an unchanged edit without retaining provider text (HTTP %i)",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          Response.json(
            {
              ok: false,
              error_code: 400,
              description: "Bad Request: message is not modified: PRIVATE_PHONE",
            },
            { status },
          ),
        ),
      );
      await expect(tg("editMessageText", {})).rejects.toMatchObject({
        status: 400,
        messageUnchanged: true,
        message: "TELEGRAM_DELIVERY_FAILED",
      });
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("PRIVATE_PHONE");
    },
  );
  it.each([
    ["sendMessage", 400, "Bad Request: message is not modified"],
    ["editMessageText", 403, "Bad Request: message is not modified"],
    ["editMessageText", 400, "Bad Request: message to edit not found"],
    ["editMessageText", 400, "Bad Request: message is not modified but unknown"],
  ])("keeps other errors as failures (%s, %i)", async (method, code, description) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            ok: false,
            error_code: code,
            description,
          },
          { status: code },
        ),
      ),
    );
    await expect(tg(method, {})).rejects.toMatchObject({ messageUnchanged: false });
  });
  it("uploads a document with a multipart boundary and DEV caption without mutating input", async () => {
    vi.stubEnv("APP_ENV", "dev");
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetcher);
    const form = new FormData();
    form.set("caption", "Учебный файл");
    form.set("document", new Blob(["sku;price\nA;10"]), "example.csv");
    await tg("sendDocument", form);
    const sent = fetcher.mock.calls[0]![1];
    expect(sent.headers["Content-Type"]).toBeUndefined();
    expect(sent.body.get("caption")).toBe("ТЕСТОВЫЙ МАГАЗИН · DEV\nУчебный файл");
    const content = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsText(sent.body.get("document"));
    });
    expect(content).toBe("sku;price\nA;10");
    expect(sent.body.get("document").name).toBe("example.csv");
    expect(form.get("caption")).toBe("Учебный файл");
  });
  it.each([200, 429])("retains validated retry_after on HTTP %i", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { ok: false, error_code: 429, parameters: { retry_after: 300 } },
            { status },
          ),
        ),
    );
    await expect(tg("sendMessage", {})).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 300,
    });
  });
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
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
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
