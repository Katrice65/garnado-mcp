import "dotenv/config";
import { requireToken } from "./auth.js";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerFileTools } from "./tools/files.js";
import { registerSearchTools } from "./tools/search.js";
import { registerGitTools } from "./tools/git.js";
import { registerHandoffTools } from "./tools/handoff.js";
import { WORKSPACE_ROOT } from "./sandbox.js";
import { roleStore, scopeToRole, isAllowed, type Role } from "./roles.js";
import { logCall } from "./audit.js";

const PORT = Number(process.env.PORT ?? 3000);

function buildServer(role: Role): McpServer {
  const server = scopeToRole(new McpServer({ name: "garnado-mcp", version: "0.3.0" }), role);
  registerFileTools(server);
  registerSearchTools(server);
  registerGitTools(server);
  registerHandoffTools(server);
  return server;
}

const app = express();
app.use(express.json());

app.post(["/mcp", "/mcp/:secret"], requireToken, async (req, res) => {
  const role = res.locals.role as Role;
  await roleStore.run(role, async () => {
    try {
      // Record attempts to call a tool this role does not have.
      const body = req.body;
      if (body?.method === "tools/call" && !isAllowed(role, String(body.params?.name))) {
        await logCall({
          tool: String(body.params?.name),
          args: {},
          ok: false,
          ms: 0,
          error: `denied: role '${role}' may not call this tool`,
        });
      }

      const server = buildServer(role);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("Error handling MCP request:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });
});

const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
};
app.get(["/mcp", "/mcp/:secret"], requireToken, methodNotAllowed);
app.delete(["/mcp", "/mcp/:secret"], requireToken, methodNotAllowed);

app.listen(PORT, () => {
  console.log(`MCP server listening on http://localhost:${PORT}/mcp`);
  console.log(`Workspace root: ${WORKSPACE_ROOT}`);
});