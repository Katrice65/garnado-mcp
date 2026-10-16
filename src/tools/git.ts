import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { resolveSafe, WORKSPACE_ROOT } from "../sandbox.js";
import { run, ok, ToolError, PROTECTED } from "./files.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_CHARS = 8000;
const GIT_TIMEOUT_MS = 10_000;

// Runs git with execFile (arguments are a list, never a shell string, so nothing can be injected).
// GIT_CEILING_DIRECTORIES stops git from walking up into the Garnado project repo
// if the workspace repo is ever missing.
async function git(args: string[]): Promise<string> {
  const root = await realpath(WORKSPACE_ROOT);
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: root,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 5_000_000,
      windowsHide: true,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(root), GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (e.code === "ENOENT") throw new ToolError("git is not installed or not on the server's PATH.");
    if (e.killed) throw new ToolError("git took too long and was stopped.");
    const msg = (e.stderr || e.message || "").toString().trim().slice(0, 500);
    throw new ToolError(`git failed: ${msg}`);
  }
}

// Validates user paths against the sandbox and returns them relative to the workspace.
async function relPaths(paths: string[] | undefined): Promise<string[]> {
  const root = await realpath(WORKSPACE_ROOT);
  const out: string[] = [];
  for (const p of paths ?? []) {
    const abs = await resolveSafe(p);
    const rel = path.relative(root, abs);
    if (PROTECTED.has(rel.split(path.sep)[0])) throw new ToolError(`'${rel}' is protected.`);
    out.push((rel || ".").split(path.sep).join("/"));
  }
  return out;
}

function cap(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? text.slice(0, MAX_OUTPUT_CHARS) + `\n...output truncated at ${MAX_OUTPUT_CHARS} characters. Pass a path to narrow it.`
    : text;
}

export function registerGitTools(server: McpServer): void {
  // ---------- git_status ----------
  server.registerTool(
    "git_status",
    {
      title: "Git status",
      description:
        "Show the branch and which workspace files are modified, new (??), or deleted. " +
        "Call this before git_commit to see what will be included.",
      inputSchema: {},
    },
    async () =>
      run("git_status", {}, async () => {
        const out = await git(["status", "--short", "--branch"]);
        return ok(cap(out.trim() || "(no output)"));
      })
  );

  // ---------- git_diff ----------
  server.registerTool(
    "git_diff",
    {
      title: "Git diff",
      description:
        "Show line-by-line changes to tracked files. New untracked files do not appear here; use git_status for those. " +
        "Output is capped, so pass path to look at one file.",
      inputSchema: {
        path: z.string().optional().describe("Limit the diff to this file or folder, relative to the workspace."),
        staged: z.boolean().optional().describe("Show staged changes instead. Default false."),
      },
    },
    async ({ path: p, staged }) =>
      run("git_diff", { path: p, staged }, async () => {
        const paths = await relPaths(p ? [p] : undefined);
        const out = await git(["diff", "--no-color", ...(staged ? ["--staged"] : []), "--", ...paths]);
        return ok(cap(out.trim() || "No changes."));
      })
  );

  // ---------- git_log ----------
  server.registerTool(
    "git_log",
    {
      title: "Git log",
      description: "Show recent commits, one line each (hash and message), newest first.",
      inputSchema: {
        max_count: z.number().int().min(1).max(50).optional().describe("How many commits. Default 10, max 50."),
      },
    },
    async ({ max_count }) =>
      run("git_log", { max_count }, async () => {
        const out = await git(["log", "--oneline", "--no-color", "-n", String(max_count ?? 10)]);
        return ok(cap(out.trim() || "No commits yet."));
      })
  );

  // ---------- git_commit ----------
  server.registerTool(
    "git_commit",
    {
      title: "Git commit",
      description:
        "Stage changes and commit them with a message. With no paths it stages everything in the workspace; " +
        "pass paths to commit only specific files. Check git_status first.",
      inputSchema: {
        message: z.string().min(3).max(200).describe("Commit message, one short line."),
        paths: z.array(z.string().min(1)).max(50).optional().describe("Files or folders to stage. Default: everything."),
      },
    },
    async ({ message, paths }) =>
      run("git_commit", { message, paths }, async () => {
        const rel = await relPaths(paths);
        await git(["add", "-A", "--", ...(rel.length > 0 ? rel : ["."])]);
        const staged = (await git(["diff", "--cached", "--name-only"])).trim();
        if (!staged) throw new ToolError("Nothing to commit. Call git_status to see the current state.");
        await git(["-c", "commit.gpgsign=false", "commit", "-m", message]);
        const last = (await git(["log", "--oneline", "-n", "1"])).trim();
        const count = staged.split("\n").length;
        return ok(`Committed ${count} file(s): ${last}`);
      })
  );
}   