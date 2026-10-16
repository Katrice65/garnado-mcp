import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile, writeFile, appendFile, readdir, mkdir } from "node:fs/promises";
import { resolveSafe } from "../sandbox.js";
import { run, ok, ToolError } from "./files.js";

const MAX_STATE_CHARS = 8000;
const MAX_ENTRY_CHARS = 2000;
const MAX_TAIL_CHARS = 4000;
const PLAN_ENTRIES = 5;
const DECISION_ENTRIES = 3;

async function readIfExists(rel: string): Promise<string | null> {
  const abs = await resolveSafe(rel);
  try {
    return await readFile(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// Last N entries of an append-only log. Entries start with "## <timestamp>".
function lastEntries(text: string, n: number): string {
  const entries = text.split(/\n(?=## )/).filter((e) => e.trim().length > 0);
  const tail = entries.slice(-n).join("\n").trim();
  return tail.length > MAX_TAIL_CHARS ? "...(older text clipped)\n" + tail.slice(-MAX_TAIL_CHARS) : tail;
}

export function registerHandoffTools(server: McpServer): void {
  // ---------- get_handoff ----------
  server.registerTool(
    "get_handoff",
    {
      title: "Get handoff",
      description:
        "Call this FIRST in every new session. Returns the project state, the latest plan-log entries, " +
        "recent decisions and the newest checkpoint in one response, so you can continue without being re-briefed.",
      inputSchema: {},
    },
    async () =>
      run("get_handoff", {}, async () => {
        const state = await readIfExists("PROJECT_STATE.md");
        const plan = await readIfExists("PLAN_LOG.md");
        const decisions = await readIfExists("DECISIONS.md");

        let latest: { name: string; text: string } | null = null;
        try {
          const dir = await resolveSafe("CHECKPOINTS");
          const names = (await readdir(dir)).filter((n) => n.endsWith(".md")).sort();
          if (names.length > 0) {
            const name = names[names.length - 1];
            latest = { name, text: await readFile(await resolveSafe(`CHECKPOINTS/${name}`), "utf8") };
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }

        if (!state && !plan && !decisions && !latest) {
          return ok(
            "No handoff yet: this is a fresh project. Start by planning, then record it with " +
              "append_plan_log and save_checkpoint."
          );
        }
        const parts: string[] = [];
        parts.push("# PROJECT_STATE\n" + (state ? state.slice(0, MAX_STATE_CHARS) : "(none yet)"));
        parts.push(`# PLAN_LOG (last ${PLAN_ENTRIES} entries)\n` + (plan ? lastEntries(plan, PLAN_ENTRIES) : "(none yet)"));
        parts.push(`# DECISIONS (last ${DECISION_ENTRIES})\n` + (decisions ? lastEntries(decisions, DECISION_ENTRIES) : "(none yet)"));
        parts.push(
          "# LATEST CHECKPOINT" + (latest ? ` (${latest.name})\n${latest.text.slice(0, MAX_STATE_CHARS)}` : "\n(none yet)")
        );
        return ok(parts.join("\n\n"));
      })
  );

  // ---------- append_plan_log ----------
  server.registerTool(
    "append_plan_log",
    {
      title: "Append plan log",
      description:
        "Add a timestamped entry to the append-only plan log (what you did or will do next), or to the " +
        "decisions file when kind is 'decision' (a choice and the reason for it). Entries cannot be edited later.",
      inputSchema: {
        entry: z.string().min(3).max(MAX_ENTRY_CHARS).describe("The entry text. Keep it short and specific."),
        kind: z.enum(["plan", "decision"]).optional().describe("'plan' (default) or 'decision'."),
      },
    },
    async ({ entry, kind }) =>
      run("append_plan_log", { entry, kind }, async () => {
        const file = kind === "decision" ? "DECISIONS.md" : "PLAN_LOG.md";
        const abs = await resolveSafe(file);
        const ts = new Date().toISOString();
        await appendFile(abs, `\n## ${ts}\n${entry.trim()}\n`, "utf8");
        return ok(`Added entry to ${file} (${ts}).`);
      })
  );

  // ---------- save_checkpoint ----------
  server.registerTool(
    "save_checkpoint",
    {
      title: "Save checkpoint",
      description:
        "Save a milestone checkpoint at the end of a session or major step. Writes a new file in CHECKPOINTS/ " +
        "(never overwrites an old one) and replaces PROJECT_STATE.md with the state you give. " +
        "State should say: what exists, what is done, what is next.",
      inputSchema: {
        name: z.string().regex(/^[a-z0-9-]{1,40}$/, "lowercase letters, digits and hyphens only").describe("Short label, e.g. 'session1-scaffold'."),
        summary: z.string().min(3).max(MAX_ENTRY_CHARS).describe("What happened in this stretch of work."),
        state: z.string().min(3).max(MAX_STATE_CHARS).describe("Complete current project state for the next session."),
      },
    },
    async ({ name, summary, state }) =>
      run("save_checkpoint", { name, summary, state }, async () => {
        await mkdir(await resolveSafe("CHECKPOINTS"), { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const rel = `CHECKPOINTS/${stamp}-${name}.md`;
        try {
          await writeFile(await resolveSafe(rel), `# Checkpoint: ${name}\n\n${summary.trim()}\n`, { encoding: "utf8", flag: "wx" });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new ToolError("That checkpoint already exists. Use a different name.");
          throw err;
        }
        await writeFile(await resolveSafe("PROJECT_STATE.md"), state.trim() + "\n", "utf8");
        return ok(`Saved ${rel} and updated PROJECT_STATE.md.`);
      })
  );
}