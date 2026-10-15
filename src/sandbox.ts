import path from "node:path";
import { realpath } from "node:fs/promises";

export const WORKSPACE_ROOT = path.resolve(process.cwd(), "workspace");

export class SandboxError extends Error {}

/**
 * Turns a user-supplied relative path into a safe absolute path inside the workspace.
 * Throws SandboxError if the path tries to escape.
 */
export async function resolveSafe(
  userPath: string,
  root: string = WORKSPACE_ROOT
): Promise<string> {
  if (typeof userPath !== "string" || userPath.length === 0) {
    throw new SandboxError("Path must be a non-empty string.");
  }
  if (userPath.includes("\0")) {
    throw new SandboxError("Path contains a null byte.");
  }
  if (path.isAbsolute(userPath) || /^[a-zA-Z]:/.test(userPath)) {
    throw new SandboxError("Absolute paths are not allowed. Use a path relative to the workspace.");
  }

  const realRoot = await realpath(root);
  const candidate = path.resolve(realRoot, userPath);

  // Resolve symlinks on the deepest part of the path that already exists,
  // so a symlink pointing outside the workspace is caught.
  let existing = candidate;
  let tail = "";
  for (;;) {
    try {
      const real = await realpath(existing);
      const full = tail ? path.join(real, tail) : real;
      assertInside(full, realRoot);
      return full;
    } catch (err) {
      if (err instanceof SandboxError) throw err;
      const parent = path.dirname(existing);
      if (parent === existing) throw new SandboxError("Path could not be resolved.");
      tail = tail ? path.join(path.basename(existing), tail) : path.basename(existing);
      existing = parent;
    }
  }
}

function assertInside(full: string, realRoot: string): void {
  const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (full !== realRoot && !full.startsWith(rootWithSep)) {
    throw new SandboxError("Path escapes the workspace and was rejected.");
  }
}