import { timingSafeEqual } from "node:crypto";
import { telegramConfig, type BotRole } from "./transport-config";
import { processClaimedUpdate } from "./webhook-processing";

export async function receiveTelegramWebhook(request: Request, role: BotRole) {
  let config: ReturnType<typeof telegramConfig>;
  try {
    config = telegramConfig(process.env, role);
  } catch {
    return new Response("Telegram not configured", { status: 503 });
  }
  const supplied = Buffer.from(request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "");
  const expected = Buffer.from(config.secret);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    return new Response("Unauthorized", { status: 401 });
  // Bound both declared and actual payload before parsing.
  if (Number(request.headers.get("content-length")) > 262144)
    return new Response("Update too large", { status: 413 });
  let update;
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 262144) {
        await reader.cancel();
        return new Response("Update too large", { status: 413 });
      }
      chunks.push(value);
    }
    update = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return new Response("Invalid update", { status: 400 });
  }
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0)
    return new Response("Invalid update", { status: 400 });
  const { claimBotUpdate } = await import("./claim.server");
  return processClaimedUpdate(
    update.update_id,
    {
      claim: (id) => claimBotUpdate(config.botId, id, role),
    },
    async () => {
      if (role === "customer") {
        const { handleCustomerUpdate } = await import("./customer.server");
        await handleCustomerUpdate(update);
      } else {
        const { handleUpdate } = await import("./handler.server");
        await handleUpdate(update);
      }
    },
  );
}
