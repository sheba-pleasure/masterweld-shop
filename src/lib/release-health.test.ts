import { describe, expect, it } from "vitest";
import { releaseHealth } from "./release-health.server";

describe("release readiness snapshot", () => {
  it.each([
    undefined,
    null,
    {},
    { ready: false },
    { ready: true, revision: "short", environment: "production" },
    { ready: true, revision: "a".repeat(40), environment: "other" },
  ])("fails closed until standalone startup verifies the build", async (state) => {
    const response = releaseHealth(state);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ready: false });
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("exposes only the immutable public revision and environment", async () => {
    const response = releaseHealth({
      ready: true,
      revision: "a".repeat(40),
      environment: "production",
      token: "must-never-leak",
      database: "private-endpoint",
      instanceId: "private-marker",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ready: true,
      revision: "a".repeat(40),
      environment: "production",
    });
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("keeps DEV identifiable instead of presenting it as production", async () => {
    const response = releaseHealth({ ready: true, revision: "b".repeat(40), environment: "dev" });
    expect(await response.json()).toEqual({
      ready: true,
      revision: "b".repeat(40),
      environment: "dev",
    });
  });
});
