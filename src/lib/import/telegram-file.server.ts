import { tg } from "@/lib/bot/telegram.server";
import { telegramConfig } from "@/lib/bot/transport-config";
import { CATALOG_FILE_BYTES } from "./catalog-file";
export interface ImportDocument {
  file_id?: string;
  file_name?: string;
  file_size?: number;
  mime_type?: string;
}
export async function downloadCatalogDocument(doc: ImportDocument): Promise<Uint8Array> {
  if (!doc.file_name || !/\.csv$/i.test(doc.file_name)) throw new Error("FILE_FORMAT");
  return downloadTelegramDocument(doc, CATALOG_FILE_BYTES);
}
export async function downloadIntakeDocument(doc: ImportDocument): Promise<Uint8Array> {
  if (!doc.file_name || doc.file_name.length > 200) throw new Error("FILE_FORMAT");
  return downloadTelegramDocument(doc, 5 * 1024 * 1024);
}
async function downloadTelegramDocument(doc: ImportDocument, limit: number): Promise<Uint8Array> {
  if (!doc.file_id || doc.file_id.length > 512) throw new Error("FILE_DOWNLOAD");
  if (
    doc.file_size !== undefined &&
    (!Number.isSafeInteger(doc.file_size) || doc.file_size < 0 || doc.file_size > limit)
  )
    throw new Error("FILE_TOO_LARGE");
  try {
    const config = telegramConfig(process.env);
    const response = await tg("getFile", { file_id: doc.file_id });
    const data = await response.json();
    const path: unknown = data.result?.file_path;
    if (
      typeof path !== "string" ||
      !/^[A-Za-z0-9_/-]+\.[A-Za-z0-9]+$/.test(path) ||
      path.startsWith("/") ||
      path.split("/").includes("..")
    )
      throw new Error("FILE_DOWNLOAD");
    if (typeof data.result?.file_size === "number" && data.result.file_size > limit)
      throw new Error("FILE_TOO_LARGE");
    // Only the fixed Telegram origin. No arbitrary URLs, redirects, filesystem paths or logging.
    const token = config.baseUrl.split("/bot")[1];
    if (!token || !config.baseUrl.startsWith("https://api.telegram.org/bot"))
      throw new Error("FILE_DOWNLOAD");
    const res = await fetch("https://api.telegram.org/file/bot" + token + "/" + path, {
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok || !res.body) throw new Error("FILE_DOWNLOAD");
    if (Number(res.headers.get("content-length")) > limit) {
      await res.body.cancel();
      throw new Error("FILE_TOO_LARGE");
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw new Error("FILE_TOO_LARGE");
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let position = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, position);
      position += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    // Fetch/provider errors can embed token-bearing URLs; never propagate those details.
    throw new Error(
      error instanceof Error && error.message === "FILE_TOO_LARGE"
        ? "FILE_TOO_LARGE"
        : "FILE_DOWNLOAD",
    );
  }
}
