import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomBytes } from "node:crypto";

/**
 * State directory resolution, following OS conventions.
 * Override with C2C_STATE_DIR (used heavily by tests).
 */
export function getStateDir(): string {
  const override = process.env.C2C_STATE_DIR;
  if (override && override.trim() !== "") return path.resolve(override);
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "codex-with-chatgpt");
    case "win32":
      return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "codex-with-chatgpt");
    default: {
      const base = process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state");
      return path.join(base, "codex-with-chatgpt");
    }
  }
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function stateSubdir(name: string): string {
  return ensureDir(path.join(getStateDir(), name));
}

/** Write a JSON file with owner-only permissions, replacing it atomically. */
export function writeSecureJson(file: string, data: unknown): void {
  const dir = ensureDir(path.dirname(file));
  const temporary = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(temporary, 0o600);
    } catch {
      // best effort on platforms without chmod semantics
    }
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // best effort cleanup
    }
    throw error;
  }
}

/** Read JSON while preserving parse/I/O errors for fail-closed state readers. */
export function readJsonStrict<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function readJsonIfExists<T>(file: string): T | null {
  try {
    return readJsonStrict<T>(file);
  } catch {
    return null;
  }
}

export const DEFAULT_PORT = 48765;
export const DEFAULT_HOST = "127.0.0.1";
