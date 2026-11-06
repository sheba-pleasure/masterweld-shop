import { writeFileSync } from "node:fs";
const environment = process.env.VITE_APP_ENV;
if (!["dev", "production"].includes(environment)) throw new Error("VITE_APP_ENV_REQUIRED");
const url = new URL(process.env.VITE_SUPABASE_URL);
writeFileSync(".output/mw-environment.json", JSON.stringify({
  environment,
  origin: process.env.PUBLIC_ORIGIN || url.origin,
  publicUrl: url.href.replace(/\/$/, ""),
  publicKey: process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
}));
