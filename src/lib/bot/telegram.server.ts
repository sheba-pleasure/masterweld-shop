const GATEWAY_URL = "https://connector-gateway.lovable.dev/telegram";

export class TelegramDeliveryError extends Error {
  constructor(
    public readonly kind: "configuration" | "network" | "http" | "api" | "protocol",
    public readonly temporary: boolean,
    public readonly status?: number,
  ) {
    super("TELEGRAM_DELIVERY_FAILED");
    this.name = "TelegramDeliveryError";
  }
}

function fail(kind: TelegramDeliveryError["kind"], temporary: boolean, status?: number): never {
  // Fixed categories only: never method, request, response body or provider description.
  console.error("[telegram] delivery failed", { kind, temporary, status });
  throw new TelegramDeliveryError(kind, temporary, status);
}

export async function tg(method: string, body: unknown) {
  const lk = process.env["LOVABLE_API_KEY"];
  const tk = process.env["TELEGRAM_API_KEY"];
  if (!lk || !tk) return fail("configuration", false);
  let res: Response;
  try {
    res = await fetch(`${GATEWAY_URL}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lk}`,
        "X-Connection-Api-Key": tk,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    return fail("network", true);
  }
  if (!res.ok) {
    return fail("http", res.status === 429 || res.status >= 500, res.status);
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
    return fail("api", code === 429 || (code !== undefined && code >= 500), code);
  }
  return res;
}
