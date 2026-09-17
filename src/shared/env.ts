import { readFileSync } from "fs";
import { resolve } from "path";

// Tiny .env loader so the demo works without extra dependencies.
// Call once at process start (activities / CLIs). Does not override existing vars.
export function loadEnv(): void {
  let text: string;
  try {
    text = readFileSync(resolve(process.cwd(), ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^["']|["']$/g, "");
  }
}
