import { createHash } from "node:crypto";
import type { TgUpdate } from "./handler.server";

// Only public identity enters the key. Repeated clicks recover the same preview.
export function previewRequestId(update: TgUpdate, botId: string | undefined): string | null {
  if (!botId || !/^[1-9][0-9]*$/.test(botId)) return null;
  const cb = update.callback_query;
  const actor = cb?.from?.id ?? update.message?.from?.id;
  const message = cb?.message?.message_id ?? update.message?.message_id;
  if (!Number.isSafeInteger(actor) || !actor || actor <= 0) return null;
  const source = cb
    ? cb.data?.startsWith("rb:")
      ? ["rollback", cb.data]
      : ["button", message, cb.data]
    : ["message", message ?? update.update_id, update.message?.text];
  if (
    cb &&
    !cb.data?.startsWith("rb:") &&
    (!Number.isSafeInteger(message) || !message || message <= 0)
  )
    return null;
  if (!cb && (!Number.isSafeInteger(source[1]) || Number(source[1]) < 0)) return null;
  const hex = createHash("sha256")
    .update(JSON.stringify(["mw-preview-v1", botId, actor, source]))
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function isDirectPreview(update: TgUpdate): boolean {
  if (update.callback_query)
    return /^(?:pxp|pxs|phm|phu|phn|phx|stp|rb):/.test(update.callback_query.data ?? "");
  return /^\/(?:price|stock|set)(?:@[a-z0-9_]+)?(?:\s|$)/i.test(update.message?.text ?? "");
}
