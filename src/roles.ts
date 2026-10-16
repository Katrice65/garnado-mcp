import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type Role = "planner" | "builder";

// Planner: read-only tools plus the handoff tools. Builder: everything.
const PLANNER_TOOLS = new Set([
  "list_files",
  "read_file",
  "search_code",
  "git_status",
  "git_diff",
  "git_log",
  "get_handoff",
  "append_plan_log",
  "save_checkpoint",
]);

export const isAllowed = (role: Role, tool: string): boolean => role === "builder" || PLANNER_TOOLS.has(tool);

// Remembers which role is handling the current request, so the audit log can record it.
export const roleStore = new AsyncLocalStorage<Role>();

// Tools a role may not use are never registered, so they do not exist for that session.
export function scopeToRole(server: McpServer, role: Role): McpServer {
  if (role === "builder") return server;
  const original = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  (server as unknown as { registerTool: unknown }).registerTool = (name: string, ...rest: unknown[]) =>
    isAllowed(role, name) ? original(name, ...rest) : undefined;
  return server;
}
