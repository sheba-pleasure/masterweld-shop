type StartupHealth = { ready?: unknown; revision?: unknown; environment?: unknown };

// The standalone entrypoint sets this non-writable symbol only after its guards pass.
// This is startup/readiness evidence, not a continuous database or Telegram probe.
export function releaseHealth(
  value: unknown = (globalThis as Record<symbol, unknown>)[Symbol.for("masterweld.runtime.health")],
): Response {
  const health = value && typeof value === "object" ? (value as StartupHealth) : undefined;
  const valid =
    health?.ready === true &&
    typeof health.revision === "string" &&
    /^[0-9a-f]{40}$/.test(health.revision) &&
    (health.environment === "dev" || health.environment === "production");
  return Response.json(
    valid
      ? { ready: true, revision: health.revision, environment: health.environment }
      : { ready: false },
    {
      status: valid ? 200 : 503,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "X-Robots-Tag": "noindex, nofollow",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
