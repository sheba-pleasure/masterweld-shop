import { writeFileSync } from "node:fs";
const environment = process.env.VITE_APP_ENV;
const revision = process.env.GIT_SHA;
if (!/^[0-9a-f]{40}$/.test(revision || "")) throw new Error("BUILD_REVISION_REQUIRED");
if (!["dev", "production"].includes(environment)) throw new Error("VITE_APP_ENV_REQUIRED");
const url = new URL(process.env.VITE_SUPABASE_URL);
writeFileSync(".output/mw-environment.json", JSON.stringify({
  environment,
  revision,
  origin: process.env.PUBLIC_ORIGIN || url.origin,
  publicUrl: url.href.replace(/\/$/, ""),
  publicKey: process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
}));
