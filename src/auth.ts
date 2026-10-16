import { timingSafeEqual, createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { Role } from "./roles.js";

const sha = (s: string) => createHash("sha256").update(s).digest();
const same = (a: string, b: string) => timingSafeEqual(sha(a), sha(b));

interface Credential {
  role: Role;
  kind: "header" | "url";
  secret: string | undefined;
  minLength: number;
}

export function requireToken(req: Request, res: Response, next: NextFunction): void {
  const builderToken = process.env.MCP_TOKEN;
  if (!builderToken || builderToken.length < 16) {
    res.status(500).json({ error: "Server misconfigured: MCP_TOKEN is missing or too short." });
    return;
  }

  // What the caller presented: a bearer header, or a secret in the URL path (/mcp/<secret>).
  const presentedHeader = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  const presentedPath = typeof req.params.secret === "string" ? req.params.secret : undefined;

  // Each credential maps to exactly one role. Planner credentials are optional.
  const credentials: Credential[] = [
    { role: "builder", kind: "header", secret: builderToken, minLength: 16 },
    { role: "builder", kind: "url", secret: process.env.MCP_URL_SECRET, minLength: 32 },
    { role: "planner", kind: "header", secret: process.env.MCP_PLANNER_TOKEN, minLength: 16 },
    { role: "planner", kind: "url", secret: process.env.MCP_PLANNER_URL_SECRET, minLength: 32 },
  ];

  for (const c of credentials) {
    const presented = c.kind === "header" ? presentedHeader : presentedPath;
    if (presented !== undefined && c.secret && c.secret.length >= c.minLength && same(presented, c.secret)) {
      res.locals.role = c.role;
      next();
      return;
    }
  }
  res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "Unauthorized" });
}