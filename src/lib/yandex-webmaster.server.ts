// Read-only Yandex Webmaster API diagnostics. Only GET requests are ever sent.
// The OAuth token is never returned, logged, or included in error messages.

const API = "https://api.webmaster.yandex.net/v4";
const SITE_HOST = "masterweld.ru";

export type StepResult = {
  step: string;
  url: string; // never contains the token
  executedFrom: string;
  ok: boolean;
  httpStatus: number | null;
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
  networkError?: string;
  note?: string;
};

function scrub(text: string, token: string): string {
  return token ? text.split(token).join("[REDACTED]") : text;
}

async function getJson(
  step: string,
  url: string,
  token: string,
  executedFrom: string,
): Promise<{ result: StepResult; body: any }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `OAuth ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });
    const raw = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    const result: StepResult = {
      step,
      url,
      executedFrom,
      ok: res.ok,
      httpStatus: res.status,
      durationMs: Date.now() - started,
    };
    if (!res.ok) {
      result.errorCode = body?.error_code ?? undefined;
      result.errorMessage = scrub(
        String(body?.error_message ?? raw.slice(0, 300) ?? ""),
        token,
      );
    }
    return { result, body };
  } catch (e: any) {
    const cause = e?.cause ? ` (cause: ${String(e.cause?.code ?? e.cause?.message ?? e.cause)})` : "";
    return {
      result: {
        step,
        url,
        executedFrom,
        ok: false,
        httpStatus: null,
        durationMs: Date.now() - started,
        networkError: scrub(
          e?.name === "AbortError"
            ? "Timeout: no HTTP response within 20s"
            : `${e?.name ?? "Error"}: ${e?.message ?? String(e)}${cause}`,
          token,
        ),
      },
      body: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function runWebmasterDiagnostics(executedFrom: string) {
  const raw = process.env["YANDEX_WEBMASTER_TOKEN"] ?? "";
  const token = raw.trim().replace(/^(OAuth|Bearer)\s+/i, "");
  const tokenInfo = {
    secretPresent: raw.length > 0,
    hadWhitespaceOrPrefix: raw.length > 0 && raw !== token,
  };
  const steps: StepResult[] = [];
  if (!token) return { tokenInfo, steps, host: null, summary: null };

  const u = await getJson("GET /v4/user", `${API}/user`, token, executedFrom);
  steps.push(u.result);
  const userId = u.body?.user_id;
  if (!u.result.ok || !userId) return { tokenInfo, steps, host: null, summary: null };

  const h = await getJson("GET /v4/user/{user_id}/hosts", `${API}/user/${userId}/hosts`, token, executedFrom);
  const hosts: any[] = Array.isArray(h.body?.hosts) ? h.body.hosts : [];
  const match = hosts.find((x) => {
    const hostUrl = String(x?.ascii_host_url ?? x?.unicode_host_url ?? "").toLowerCase();
    return hostUrl.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "") === SITE_HOST;
  });
  h.result.note = `hosts in account: ${hosts.length}; ${SITE_HOST} ${match ? "found" : "NOT found"}${
    hosts.length ? `; listed: ${hosts.map((x) => x?.ascii_host_url).join(", ")}` : ""
  }`;
  steps.push(h.result);
  if (!match) return { tokenInfo, steps, host: null, summary: null };

  const hostId = String(match.host_id);
  const host = { host_id: hostId, url: match.ascii_host_url, verified: match.verified ?? null };
  const s = await getJson(
    "GET /v4/user/{user_id}/hosts/{host_id}/summary",
    `${API}/user/${userId}/hosts/${encodeURIComponent(hostId)}/summary`,
    token,
    executedFrom,
  );
  steps.push(s.result);
  return { tokenInfo, steps, host, summary: s.result.ok ? s.body : null };
}
