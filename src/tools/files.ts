import { logCall } from "../audit.js";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readdir, readFile, writeFile, mkdir, rename, stat, realpath } from "node:fs/promises";
import path from "node:path";
import { resolveSafe, SandboxError, WORKSPACE_ROOT } from "../sandbox.js";

// ---- limits and protected paths ----
const MAX_LIST_ENTRIES = 200;
const DEFAULT_READ_LINES = 200;
const MAX_READ_BYTES = 2_000_000;
const MAX_WRITE_CHARS = 200_000;
export const PROTECTED = new Set([".git", ".env", ".trash"]);
const MAX_MANY_FILES = 10;
const MANY_LINES_PER_FILE = 100;
const MAX_MANY_CHARS = 30_000;

// ---- result helpers ----
export const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });

export class ToolError extends Error {}

// Wraps every tool: turns errors into helpful isError messages (never stack traces)
// and writes one audit-log line per call.
export async function run(tool: string, args: Record<string, unknown>, fn: () => Promise<ReturnType<typeof ok>>) {
  const started = Date.now();
  let result: ReturnType<typeof ok> | ReturnType<typeof fail>;
  try {
    result = await fn();
  } catch (err) {
    if (err instanceof SandboxError || err instanceof ToolError) result = fail(err.message);
    else {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") result = fail("Not found. Call list_files to see what exists.");
      else if (code === "EISDIR") result = fail("That path is a directory. Call list_files to see inside it.");
      else if (code === "ENOTDIR") result = fail("A part of that path is a file, not a folder.");
      else result = fail(`Unexpected error: ${(err as Error).message}`);
    }
  }
  const failed = "isError" in result;
  await logCall({
    tool,
    args,
    ok: !failed,
    ms: Date.now() - started,
    error: failed ? result.content[0].text : undefined,
  });
  return result;
}

const HANDOFF_FILES = new Set(["PROJECT_STATE.MD", "PLAN_LOG.MD", "DECISIONS.MD", "CHECKPOINTS"]);

// Returns the path relative to the workspace, and refuses protected locations.
// Windows paths are case-insensitive, so names are compared in a single case.
async function guard(abs: string, action: string): Promise<string> {
  const realRoot = await realpath(WORKSPACE_ROOT);
  const rel = path.relative(realRoot, abs);
  const first = rel.split(path.sep)[0];
  if (PROTECTED.has(first.toLowerCase())) {
    throw new ToolError(`'${rel}' is protected and cannot be ${action}.`);
  }
  if (action !== "read" && HANDOFF_FILES.has(first.toUpperCase())) {
    throw new ToolError(
      `'${rel}' is a handoff file and cannot be ${action} directly. Use append_plan_log or save_checkpoint instead.`
    );
  }
  return rel;
}
// Shared by read_file and read_many_files: returns numbered lines for one file.
async function readNumbered(
  p: string,
  start_line: number | undefined,
  end_line: number | undefined,
  maxLines: number
): Promise<string> {
  const abs = await resolveSafe(p);
  const rel = await guard(abs, "read");
  const info = await stat(abs);
  if (!info.isFile()) throw new ToolError(`'${rel}' is not a file.`);
  if (info.size > MAX_READ_BYTES) {
    throw new ToolError(`'${rel}' is too large (${info.size} bytes). Limit is ${MAX_READ_BYTES}.`);
  }
  const fileContent = await readFile(abs, "utf8");
  if (fileContent.includes("\u0000")) {
    throw new ToolError(`'${rel}' does not look like a UTF-8 text file (it may be binary or UTF-16). Cannot read it.`);
  }
  const lines = fileContent.replace(/\r?\n$/, "").split(/\r?\n/);
  const total = lines.length;
  const start = start_line ?? 1;
  let end = end_line ?? start + maxLines - 1;
  if (start > total) throw new ToolError(`start_line ${start} is past the end of the file (${total} lines).`);
  if (end < start) throw new ToolError("end_line must be greater than or equal to start_line.");
  let truncated = false;
  if (end - start + 1 > maxLines) {
    end = start + maxLines - 1;
    truncated = true;
  }
  end = Math.min(end, total);
  const body = lines
    .slice(start - 1, end)
    .map((line, i) => `${start + i}: ${line}`)
    .join("\n");
  let text = `${rel} (lines ${start}-${end} of ${total})\n${body}`;
  if (truncated || end < total) text += `\n...more lines available. Call read_file with path='${rel}' and start_line=${end + 1} to continue.`;
  return text;
}
export function registerFileTools(server: McpServer): void {
  // ---------- list_files ----------
  server.registerTool(
    "list_files",
    {
      title: "List files",
      description:
        "List files and folders inside one directory of the workspace (not recursive). " +
        "Use this first to see what exists. Folders end with '/'.",
      inputSchema: {
        path: z.string().optional().describe("Directory relative to the workspace. Defaults to the workspace root."),
      },
    },
    async ({ path: dir }) =>
      run("list_files", { path: dir }, async () => {
        const abs = await resolveSafe(dir && dir.length > 0 ? dir : ".");
        const entries = (await readdir(abs, { withFileTypes: true })).filter((e) => !PROTECTED.has(e.name));
        if (entries.length === 0) return ok("(empty)");
        const lines = entries.slice(0, MAX_LIST_ENTRIES).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        if (entries.length > MAX_LIST_ENTRIES) {
          lines.push(`...truncated: showing ${MAX_LIST_ENTRIES} of ${entries.length} entries. List a subfolder instead.`);
        }
        return ok(lines.join("\n"));
      })
  );

  // ---------- read_file ----------
  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description:
        `Read a text file with line numbers. Returns at most ${DEFAULT_READ_LINES} lines per call; ` +
        "use start_line and end_line to read a specific range instead of the whole file. " +
        "To read several files at once, use read_many_files.",
      inputSchema: {
        path: z.string().min(1).describe("File path relative to the workspace."),
        start_line: z.number().int().min(1).optional().describe("First line to read (1-based). Default 1."),
        end_line: z.number().int().min(1).optional().describe("Last line to read (inclusive)."),
      },
    },
    async ({ path: p, start_line, end_line }) =>
      run("read_file", { path: p, start_line, end_line }, async () =>
        ok(await readNumbered(p, start_line, end_line, DEFAULT_READ_LINES))
      )
  );

  // ---------- read_many_files ----------
  server.registerTool(
    "read_many_files",
    {
      title: "Read many files",
      description:
        `Read up to ${MAX_MANY_FILES} text files in ONE call (first ${MANY_LINES_PER_FILE} lines of each, numbered). ` +
        "Use this instead of several read_file calls. A bad path shows an error for that file only. " +
        "For more lines of one file, use read_file with start_line.",
      inputSchema: {
        paths: z
          .array(z.string().min(1))
          .min(1)
          .max(MAX_MANY_FILES)
          .describe(`File paths relative to the workspace (1 to ${MAX_MANY_FILES}).`),
      },
    },
    async ({ paths }) =>
      run("read_many_files", { paths }, async () => {
        const parts: string[] = [];
        let total = 0;
        for (const p of paths) {
          let part: string;
          if (total >= MAX_MANY_CHARS) {
            part = `${p}: SKIPPED, output limit reached. Call read_file for this file.`;
          } else {
            try {
              part = await readNumbered(p, undefined, undefined, MANY_LINES_PER_FILE);
            } catch (err) {
              const code = (err as NodeJS.ErrnoException).code;
              const msg =
                err instanceof SandboxError || err instanceof ToolError
                  ? err.message
                  : code === "ENOENT"
                    ? "Not found. Call list_files to see what exists."
                    : (err as Error).message;
              part = `${p}: ERROR: ${msg}`;
            }
          }
          total += part.length;
          parts.push(part);
        }
        return ok(parts.join("\n\n"));
      })
  );

  // ---------- write_file ----------
  server.registerTool(
    "write_file",
    {
      title: "Write file",
      description:
        "Create a new file, or replace an existing one entirely. Fails if the file already exists unless overwrite is true. " +
        "For small edits to an existing file, use str_replace instead.",
      inputSchema: {
        path: z.string().min(1).describe("File path relative to the workspace. Parent folders are created automatically."),
        content: z.string().max(MAX_WRITE_CHARS).describe("Full file contents."),
        overwrite: z.boolean().optional().describe("Set true to replace an existing file. Default false."),
      },
    },
    async ({ path: p, content, overwrite }) =>
      run("write_file", { path: p, content, overwrite }, async () => {
        const abs = await resolveSafe(p);
        const rel = await guard(abs, "written");
        let exists = true;
        try {
          const info = await stat(abs);
          if (info.isDirectory()) throw new ToolError(`'${rel}' is a directory.`);
        } catch (err) {
          if (err instanceof ToolError) throw err;
          exists = false;
        }
        if (exists && !overwrite) {
          throw new ToolError(`'${rel}' already exists. Use str_replace for small edits, or set overwrite: true to replace it.`);
        }
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, content, "utf8");
        return ok(`${exists ? "Overwrote" : "Created"} ${rel} (${content.length} characters).`);
      })
  );

  // ---------- str_replace ----------
  server.registerTool(
    "str_replace",
    {
      title: "Replace text in file",
      description:
        "Replace one exact piece of text in a file with new text. old_str must appear exactly once; " +
        "include surrounding lines to make it unique. Prefer this over rewriting a whole file.",
      inputSchema: {
        path: z.string().min(1).describe("File path relative to the workspace."),
        old_str: z.string().min(1).describe("Exact text to find, including whitespace."),
        new_str: z.string().max(MAX_WRITE_CHARS).describe("Replacement text. Use an empty string to delete old_str."),
      },
    },
    async ({ path: p, old_str, new_str }) =>
      run("str_replace", { path: p, old_str, new_str }, async () => {
        const abs = await resolveSafe(p);
        const rel = await guard(abs, "edited");
        const content = await readFile(abs, "utf8");
        const first = content.indexOf(old_str);
        if (first === -1) {
          throw new ToolError(`old_str was not found in '${rel}'. Call read_file on the relevant lines and copy the text exactly, including whitespace.`);
        }
        const count = content.split(old_str).length - 1;
        if (count > 1) {
          throw new ToolError(`old_str matched ${count} times in '${rel}'. Add more surrounding context so it matches exactly once.`);
        }
        const updated = content.slice(0, first) + new_str + content.slice(first + old_str.length);
        await writeFile(abs, updated, "utf8");
        return ok(`Replaced 1 occurrence in ${rel}.`);
      })
  );

  // ---------- delete_file ----------
  server.registerTool(
    "delete_file",
    {
      title: "Delete file",
      description:
        "Delete a file by moving it to the workspace .trash folder (recoverable). " +
        "Requires confirm: true. Only deletes files, not folders.",
      inputSchema: {
        path: z.string().min(1).describe("File path relative to the workspace."),
        confirm: z.boolean().optional().describe("Must be true to actually delete."),
      },
    },
    async ({ path: p, confirm }) =>
      run("delete_file", { path: p, confirm }, async () => {
        const abs = await resolveSafe(p);
        const rel = await guard(abs, "deleted");
        if (confirm !== true) {
          throw new ToolError(`Deletion not confirmed. Call delete_file again with confirm: true to move '${rel}' to .trash.`);
        }
        const info = await stat(abs);
        if (!info.isFile()) throw new ToolError(`'${rel}' is not a file. Only files can be deleted.`);
        const trashDir = await resolveSafe(".trash");
        await mkdir(trashDir, { recursive: true });
        const trashName = `${Date.now()}-${rel.split(path.sep).join("__")}`;
        await rename(abs, path.join(trashDir, trashName));
        return ok(`Moved ${rel} to .trash/${trashName}.`);
      })
  );
}