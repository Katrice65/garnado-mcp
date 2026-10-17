import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readdir, readFile, stat, realpath } from "node:fs/promises";
import path from "node:path";
import { resolveSafe, WORKSPACE_ROOT } from "../sandbox.js";
import { run, ok, ToolError, PROTECTED } from "./files.js";

// ---- limits ----
const DEFAULT_RESULTS = 30;
const MAX_RESULTS_CAP = 100;
const MAX_FILES_SCANNED = 2000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_LINE_CHARS = 200;
const SKIP_DIRS = new Set(["node_modules", "dist"]);

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (PROTECTED.has(e.name) || SKIP_DIRS.has(e.name) || e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile()) yield full;
  }
}

export function registerSearchTools(server: McpServer): void {
  server.registerTool(
    "search_code",
    {
      title: "Search code",
      description:
        "Search text files in the workspace for a literal string (not a regex). " +
        "Returns matching lines as 'path:line: text', capped. Use this to find where something is " +
        "defined or used instead of reading many files, then read_file with start_line for context.",
      inputSchema: {
        query: z.string().min(1).max(200).describe("Literal text to search for."),
        path: z.string().optional().describe("Folder to search, relative to the workspace. Defaults to the whole workspace."),
        case_sensitive: z.boolean().optional().describe("Default false."),
        max_results: z.number().int().min(1).max(MAX_RESULTS_CAP).optional().describe(`Default ${DEFAULT_RESULTS}, max ${MAX_RESULTS_CAP}.`),
      },
    },
    async ({ query, path: dir, case_sensitive, max_results }) =>
      run("search_code", { query, path: dir, case_sensitive, max_results }, async () => {
        const start = await resolveSafe(dir && dir.length > 0 ? dir : ".");
        const info = await stat(start);
        if (!info.isDirectory()) throw new ToolError("path must be a folder. Use read_file for a single file.");

        const realRoot = await realpath(WORKSPACE_ROOT);
        const needle = case_sensitive ? query : query.toLowerCase();
        const limit = max_results ?? DEFAULT_RESULTS;
        const hits: string[] = [];
        let scanned = 0;
        let hitCap = false;
        let scanCap = false;

        for await (const file of walk(start)) {
          if (scanned >= MAX_FILES_SCANNED) {
            scanCap = true;
            break;
          }
          scanned++;
          if ((await stat(file)).size > MAX_FILE_BYTES) continue;
          const text = await readFile(file, "utf8");
          if (text.includes("\u0000")) continue; // binary or UTF-16, skip
          const rel = path.relative(realRoot, file).split(path.sep).join("/");
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            const hay = case_sensitive ? lines[i] : lines[i].toLowerCase();
            if (hay.includes(needle)) {
              hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, MAX_LINE_CHARS)}`);
              if (hits.length >= limit) {
                hitCap = true;
                break;
              }
            }
          }
          if (hitCap) break;
        }

        if (hits.length === 0) {
          return ok(`No matches for "${query}" in ${scanned} files. Try a shorter query or case_sensitive: false.`);
        }
        let text = `${hits.length} match(es) in ${scanned} file(s) scanned:\n${hits.join("\n")}`;
        if (hitCap) text += `\n...stopped at ${limit} matches. Narrow with path or a more specific query.`;
        if (scanCap) text += `\n...stopped after scanning ${MAX_FILES_SCANNED} files. Search a subfolder with path.`;
        return ok(text);
      })
  );
}