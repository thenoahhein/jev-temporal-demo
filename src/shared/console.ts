// Tiny terminal formatter shared by activities, worker and CLIs.
// No dependencies — plain ANSI.

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
} as const;

export function kv(label: string, value: string): string {
  const dots = Math.max(2, 26 - label.length);
  return `${label} ${".".repeat(dots)} ${value}`;
}

export function section(title: string, ...lines: string[]): void {
  console.log(`\n${C.bold}${C.cyan}${title}${C.reset}`);
  for (const line of lines) console.log(`  ${line}`);
}

export function warnSection(title: string, ...lines: string[]): void {
  console.log(`\n${C.bold}${C.yellow}${title}${C.reset}`);
  for (const line of lines) console.log(`  ${line}`);
}

export function errorSection(title: string, ...lines: string[]): void {
  console.log(`\n${C.bold}${C.red}${title}${C.reset}`);
  for (const line of lines) console.log(`  ${line}`);
}

export function banner(text: string, color: "green" | "yellow" | "red" = "yellow"): void {
  const c = color === "green" ? C.green : color === "red" ? C.red : C.yellow;
  const line = "=".repeat(text.length + 8);
  console.log(`\n${C.bold}${c}${line}\n   ${text}   \n${line}${C.reset}\n`);
}

export const colors = C;
