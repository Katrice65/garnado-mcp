import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { roleStore } from "./roles.js";

const LOG_DIR = path.resolve(process.cwd(), "logs");
const LOG_FILE = path.join(LOG_DIR, "audit.jsonl");

// Never write file contents to the log: only their size.
const CONTENT_KEYS = new Set(["content", "old_str", "new_str"]);

export interface AuditEntry {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  ms: number;
  error?: string;
}

function summarize(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && CONTENT_KEYS.has(key)) out[key] = `<${value.length} chars>`;
    else if (typeof value === "string") out[key] = value.slice(0, 200);
    else out[key] = value;
  }
  return out;
}

export async function logCall(entry: AuditEntry): Promise<void> {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      role: roleStore.getStore() ?? "unknown",
      tool: entry.tool,
      args: summarize(entry.args),
      ok: entry.ok,
      ms: entry.ms,
      ...(entry.error ? { error: entry.error.slice(0, 300) } : {}),
    });
    await appendFile(LOG_FILE, line + "\n", "utf8");
  } catch (err) {
    console.error("audit log write failed:", (err as Error).message);
  }
}