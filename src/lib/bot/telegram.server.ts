import { telegramConfig } from "./transport-config";

export class TelegramDeliveryError extends Error {
  constructor(
    public readonly kind: "configuration" | "network" | "http" | "api" | "protocol",
    public readonly temporary: boolean,
    public readonly status?: number,
    public readonly retryAfterSeconds?: number,
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
): never {
  // Fixed categories only: never method, request, response body or provider description.
  console.error("[telegram] delivery failed", { kind, temporary, status });
  throw new TelegramDeliveryError(kind, temporary, status, retryAfterSeconds);
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

export async function tg(method: string, body: unknown) {
  let config: ReturnType<typeof telegramConfig>;
  try {
    config = telegramConfig(process.env);
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
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}/${method}`, {
      method: "POST",
      headers: {
        ...config.headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
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
    return fail("http", res.status === 429 || res.status >= 500, res.status, retryAfter);
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
    );
  }
  return res;
}
