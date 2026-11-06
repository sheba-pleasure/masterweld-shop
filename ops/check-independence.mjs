import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const provider = /@lovable[./]|lovable\.(dev|app)|lovableproject|__lovable|LOVABLE_/i;
const failures = [];
for (const path of ["package.json", "bun.lock", "vite.config.ts"]) {
  if (provider.test(readFileSync(path, "utf8"))) failures.push(path);
}
function scan(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) scan(path);
    else if (/\.(?:tsx?|m?js|html|css|json)$/.test(path) && !/\.(test|spec)\./.test(path)) {
      if (provider.test(readFileSync(path, "utf8"))) failures.push(path);
    }
  }
}
scan("src");
if (process.argv.includes("--built")) scan(".output");
if (failures.length) {
  console.error("Provider dependency found:", failures.join(", "));
  process.exit(1);
}
console.info(
  "No Lovable dependency in source, lockfile" +
    (process.argv.includes("--built") ? " or built artifact." : "."),
);
