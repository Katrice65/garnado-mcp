import express from "express";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const PORT = Number(process.env.PORT ?? 3000);
const WORKSPACE_ROOT = path.resolve(process.cwd(), "workspace");

// Builds a fresh MCP server with our tools registered on it.
function buildServer(): McpServer {
  const server = new McpServer({ name: "garnado-mcp", version: "0.1.0" });

  server.registerTool(
    "list_files",
    {
      title: "List files",
      description:
        "List the files and folders at the top level of the workspace. " +
        "Use this first to see what exists before reading or writing anything.",
      inputSchema: {},
    },
    async () => {
      try {
        const entries = await readdir(WORKSPACE_ROOT, { withFileTypes: true });
        const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        return {
          content: [
            { type: "text", text: lines.length ? lines.join("\n") : "(workspace is empty)" },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Could not list the workspace: ${(err as Error).message}` },
          ],
        };
      }
    }
  );

  return server;
}

const app = express();
app.use(express.json());

// Every MCP request arrives here. We make a new server + transport per request
// ("stateless" mode), which is the simplest setup and works fine for this project.
app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
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

// Stateless mode doesn't support GET/DELETE on /mcp.
const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.listen(PORT, () => {
  console.log(`MCP server listening on http://localhost:${PORT}/mcp`);
  console.log(`Workspace root: ${WORKSPACE_ROOT}`);
});