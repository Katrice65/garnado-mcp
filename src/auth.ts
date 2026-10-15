import { timingSafeEqual, createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const sha = (s: string) => createHash("sha256").update(s).digest();

export function requireToken(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.MCP_TOKEN;
  if (!expected || expected.length < 16) {
    res.status(500).json({ error: "Server misconfigured: MCP_TOKEN is missing or too short." });
    return;
  }
  const header = req.headers.authorization ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  const given = match ? match[1] : "";
  // Hash both sides so the comparison is constant-time and length-safe.
  if (!match || !timingSafeEqual(sha(given), sha(expected))) {
    res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "Unauthorized" });
    return;
  }
  next();
}