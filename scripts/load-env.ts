// Scripts run outside Next.js, which is what normally loads .env.local. Existing env vars win.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const file = path.join(__dirname, "..", ".env.local");
if (existsSync(file)) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || !m[2] || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
