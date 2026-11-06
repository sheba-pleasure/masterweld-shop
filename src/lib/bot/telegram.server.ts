import { telegramConfig, type BotRole } from "./transport-config";

export class TelegramDeliveryError extends Error {
  constructor(
    public readonly kind: "configuration" | "network" | "http" | "api" | "protocol",
    public readonly temporary: boolean,
    public readonly status?: number,
    public readonly retryAfterSeconds?: number,
    public readonly messageUnchanged = false,
  ) {
    super("TELEGRAM_DELIVERY_FAILED");
    this.name = "TelegramDeliveryError";
  }
}

function fail(
  kind: TelegramDeliveryError["kind"],
  temporary: boolean,
  status?: number,
  retryAfterSeconds?: number,
  messageUnchanged = false,
): never {
  // Fixed categories only: never method, request, response body or provider description.
  if (!messageUnchanged) console.error("[telegram] delivery failed", { kind, temporary, status });
  throw new TelegramDeliveryError(kind, temporary, status, retryAfterSeconds, messageUnchanged);
}

function retryDelay(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object" || !("parameters" in payload)) return;
  const params = payload.parameters;
  if (!params || typeof params !== "object" || !("retry_after" in params)) return;
  const seconds = params.retry_after;
  if (
    typeof seconds === "number" &&
    Number.isSafeInteger(seconds) &&
    seconds >= 0 &&
    seconds <= 86400
  )
    return seconds;
  return undefined;
}

function isUnchangedEdit(method: string, payload: unknown): boolean {
  if (method !== "editMessageText" || !payload || typeof payload !== "object") return false;
  if (!("ok" in payload) || payload.ok !== false) return false;
  if (!("error_code" in payload) || payload.error_code !== 400) return false;
  return (
    "description" in payload &&
    typeof payload.description === "string" &&
    /^Bad Request: message is not modified(?:$|:)/.test(payload.description)
  );
}

export async function tg(method: string, body: unknown, role: BotRole = "staff") {
  let config: ReturnType<typeof telegramConfig>;
  try {
    config = telegramConfig(process.env, role);
  } catch {
    return fail("configuration", false);
  }
  if (!/^[A-Za-z]+$/.test(method)) return fail("configuration", false);
  if (
    process.env["APP_ENV"] === "dev" &&
    body &&
    typeof body === "object" &&
    "text" in body &&
    typeof body.text === "string"
  ) {
    body = { ...body, text: `ТЕСТОВЫЙ МАГАЗИН · DEV\n${body.text}` };
  }
  if (
    process.env["APP_ENV"] === "dev" &&
    body &&
    typeof body === "object" &&
    "caption" in body &&
    typeof body.caption === "string"
  ) {
    body = { ...body, caption: `ТЕСТОВЫЙ МАГАЗИН · DEV\n${body.caption}` };
  }
  if (body instanceof FormData && process.env["APP_ENV"] === "dev") {
    const caption = body.get("caption");
    if (typeof caption === "string") {
      const copy = new FormData();
      body.forEach((value, key) => copy.append(key, value));
      copy.set("caption", `ТЕСТОВЫЙ МАГАЗИН · DEV\n${caption}`);
      body = copy;
    }
  }
  const multipart = body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}/${method}`, {
      method: "POST",
      headers: {
        ...config.headers,
        ...(multipart ? {} : { "Content-Type": "application/json" }),
      },
      body: multipart ? (body as FormData) : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return fail("network", true);
  }
  if (!res.ok) {
    let retryAfter: number | undefined;
    if (res.status === 429) {
      try {
        retryAfter = retryDelay(await res.clone().json());
      } catch {
        /* No safe retry hint. */
      }
    }
    let messageUnchanged = false;
    if (res.status === 400 && method === "editMessageText") {
      try {
        messageUnchanged = isUnchangedEdit(method, await res.clone().json());
      } catch {
        /* Unrecognised errors remain failures; never expose provider descriptions. */
      }
    }
    return fail(
      "http",
      res.status === 429 || res.status >= 500,
      res.status,
      retryAfter,
      messageUnchanged,
    );
  }
  let payload: unknown;
  try {
    payload = await res.clone().json();
  } catch {
    return fail("protocol", false, res.status);
  }
  if (!payload || typeof payload !== "object" || !("ok" in payload))
    return fail("protocol", false, res.status);
  if (payload.ok !== true) {
    const code =
      "error_code" in payload && typeof payload.error_code === "number"
        ? payload.error_code
        : undefined;
    return fail(
      "api",
      code === 429 || (code !== undefined && code >= 500),
      code,
      retryDelay(payload),
      isUnchangedEdit(method, payload),
    );
  }
  return res;
}
