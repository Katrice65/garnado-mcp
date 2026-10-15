import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSafe, SandboxError } from "../src/sandbox.js";

let base: string;
let root: string;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "sandbox-"));
  root = path.join(base, "workspace");
  await mkdir(root);
  await mkdir(path.join(base, "workspace-evil")); // sibling-prefix trick
  await writeFile(path.join(root, "ok.txt"), "hi");
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("resolveSafe", () => {
  it("allows a normal file", async () => {
    const p = await resolveSafe("ok.txt", root);
    expect(p.endsWith("ok.txt")).toBe(true);
  });

  it("allows a new file that does not exist yet", async () => {
    await expect(resolveSafe("sub/new.txt", root)).resolves.toBeTruthy();
  });

  it("rejects ../ traversal", async () => {
    await expect(resolveSafe("../secret.txt", root)).rejects.toBeInstanceOf(SandboxError);
  });

  it("rejects deep ../ traversal", async () => {
    await expect(resolveSafe("a/../../../etc/passwd", root)).rejects.toBeInstanceOf(SandboxError);
  });

  it("rejects backslash traversal", async () => {
    await expect(resolveSafe("..\\secret.txt", root)).rejects.toBeInstanceOf(SandboxError);
  });

  it("rejects absolute POSIX paths", async () => {
    await expect(resolveSafe("/etc/passwd", root)).rejects.toBeInstanceOf(SandboxError);
  });

  it("rejects Windows drive paths", async () => {
    await expect(resolveSafe("C:\\Windows\\win.ini", root)).rejects.toBeInstanceOf(SandboxError);
  });

  it("rejects null bytes", async () => {
    await expect(resolveSafe("ok.txt\0.png", root)).rejects.toBeInstanceOf(SandboxError);
  });

  it("rejects the sibling-prefix trick", async () => {
    await expect(resolveSafe("../workspace-evil/x.txt", root)).rejects.toBeInstanceOf(SandboxError);
  });

  it("rejects an empty path", async () => {
    await expect(resolveSafe("", root)).rejects.toBeInstanceOf(SandboxError);
  });
});