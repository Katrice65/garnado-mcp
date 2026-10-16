import { timingSafeEqual, createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const sha = (s: string) => createHash("sha256").update(s).digest();
const same = (a: string, b: string) => timingSafeEqual(sha(a), sha(b));

export function requireToken(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.MCP_TOKEN;
  const urlSecret = process.env.MCP_URL_SECRET;
  if (!token || token.length < 16) {
    res.status(500).json({ error: "Server misconfigured: MCP_TOKEN is missing or too short." });
    return;
  }

  // Option 1: Authorization: Bearer <MCP_TOKEN>
  const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
  const headerOk = !!match && same(match[1], token);

  // Option 2: secret in the URL path, /mcp/<MCP_URL_SECRET> (for clients that cannot send headers)
  const pathSecret = req.params.secret;
  const urlOk =
    !!urlSecret && urlSecret.length >= 32 && typeof pathSecret === "string" && same(pathSecret, urlSecret);

  if (headerOk || urlOk) {
    next();
    return;
  }
  res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "Unauthorized" });
}