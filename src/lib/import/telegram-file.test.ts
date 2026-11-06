import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ tg: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/bot/telegram.server", () => ({ tg: mocks.tg }));
vi.mock("@/lib/bot/transport-config", () => ({
  telegramConfig: () => ({ baseUrl: "https://api.telegram.org/bot123:TEST" }),
}));
import { downloadCatalogDocument } from "./telegram-file.server";
import { CATALOG_FILE_BYTES } from "./catalog-file";
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.tg.mockResolvedValue(
    Response.json({ ok: true, result: { file_path: "documents/file_1.csv" } }),
  );
  mocks.fetch.mockResolvedValue(new Response("sku;price\nA;10"));
});
afterEach(() => vi.unstubAllGlobals());
it("downloads only from fixed Telegram host and refuses redirects", async () => {
  const result = await downloadCatalogDocument({ file_id: "known", file_name: "price.csv" });
  expect(new TextDecoder().decode(result)).toContain("A;10");
  expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(
    "https://api.telegram.org/file/bot123:TEST/documents/file_1.csv",
    expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }),
  );
});
it("blocks unsupported and oversized files before provider access", async () => {
  await expect(
    downloadCatalogDocument({ file_id: "known", file_name: "price.xlsx" }),
  ).rejects.toThrow("FILE_FORMAT");
  await expect(
    downloadCatalogDocument({
      file_id: "known",
      file_name: "price.csv",
      file_size: CATALOG_FILE_BYTES + 1,
    }),
  ).rejects.toThrow("FILE_TOO_LARGE");
  expect(mocks.tg).not.toHaveBeenCalled();
});
it.each(["https://evil.test/a.csv", "../token.csv", "documents/../../a.csv", "/file.csv"])(
  "rejects provider path %s",
  async (path) => {
    mocks.tg.mockResolvedValue(Response.json({ ok: true, result: { file_path: path } }));
    await expect(
      downloadCatalogDocument({ file_id: "known", file_name: "price.csv" }),
    ).rejects.toThrow("FILE_DOWNLOAD");
    expect(mocks.fetch).not.toHaveBeenCalled();
  },
);
it("bounds streamed bytes even without Content-Length", async () => {
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(CATALOG_FILE_BYTES));
      c.enqueue(new Uint8Array(1));
      c.close();
    },
  });
  mocks.fetch.mockResolvedValue(new Response(body));
  await expect(
    downloadCatalogDocument({ file_id: "known", file_name: "price.csv" }),
  ).rejects.toThrow("FILE_TOO_LARGE");
});
it("redacts token-bearing fetch errors", async () => {
  mocks.fetch.mockRejectedValue(new Error("https://api.telegram.org/file/botSECRET/file.csv"));
  await expect(
    downloadCatalogDocument({ file_id: "known", file_name: "price.csv" }),
  ).rejects.toThrow(/^FILE_DOWNLOAD$/);
});
