import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveSafe, SandboxError } from "../src/sandbox.js";

// Uses a temp folder outside OneDrive. The "junction" link type works on Windows
// without admin rights; on Linux/macOS it becomes a normal directory symlink.
describe("resolveSafe: link escapes", () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeAll(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), "garnado-link-"));
    root = path.join(base, "ws");
    outside = path.join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "top secret");
    await writeFile(path.join(root, "ok.txt"), "fine");
    await symlink(outside, path.join(root, "link"), "junction");
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("rejects an existing file reached through a link that points outside", async () => {
    await expect(resolveSafe("link/secret.txt", root)).rejects.toBeInstanceOf(SandboxError);
  });

  it("rejects a NEW file path under a link that points outside", async () => {
    await expect(resolveSafe("link/new.txt", root)).rejects.toBeInstanceOf(SandboxError);
  });

  it("rejects the link itself", async () => {
    await expect(resolveSafe("link", root)).rejects.toBeInstanceOf(SandboxError);
  });

  it("still allows a normal file inside the workspace", async () => {
    const p = await resolveSafe("ok.txt", root);
    expect(p.endsWith("ok.txt")).toBe(true);
  });
});