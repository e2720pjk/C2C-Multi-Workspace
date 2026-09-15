import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ensureDir } from "./paths.js";

export interface LockOwner {
  pid: number;
  token: string;
  processIdentity: string | null;
  acquiredAt: string;
}

export class StateLockError extends Error {
  constructor(
    message: string,
    readonly code: "LOCKED" | "LOCK_UNKNOWN"
  ) {
    super(message);
    this.name = "StateLockError";
  }
}

export interface StateLock {
  readonly path: string;
  readonly owner: LockOwner;
  release(): void;
}

export type StateLockStatus =
  | { state: "free" }
  | { state: "held"; owner: LockOwner }
  | { state: "unknown"; reason: string };

export function processIdentityForPid(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const end = stat.lastIndexOf(")");
      const fields = end >= 0 ? stat.slice(end + 2).trim().split(/\s+/) : [];
      const start = fields[19]; // kernel field 22, after pid + comm
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (start && cmdline) return `linux:${start}:${cmdline}`;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin" || process.platform === "freebsd") {
    const result = spawnSync("ps", ["-o", "lstart=,command=", "-p", String(pid)], { encoding: "utf8" });
    const started = result.status === 0 ? result.stdout.trim() : "";
    if (started) return `bsd:${started}`;
  }
  if (process.platform === "win32") {
    const powershell = process.env.ComSpec ? "powershell.exe" : "pwsh";
    const result = spawnSync(
      powershell,
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`],
      { encoding: "utf8", windowsHide: true }
    );
    const started = result.status === 0 ? result.stdout.trim() : "";
    if (started) return `win:${started}`;
  }
  return null;
}

export function processStateForPid(pid: number): "present" | "missing" | "unknown" {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return processIdentityForPid(pid) ? "present" : "unknown";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "missing" : "unknown";
  }
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")) as Partial<LockOwner>;
    const pid = value.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || typeof value.token !== "string" || !value.token) {
      return null;
    }
    return {
      pid,
      token: value.token,
      processIdentity: typeof value.processIdentity === "string" ? value.processIdentity : null,
      acquiredAt: typeof value.acquiredAt === "string" ? value.acquiredAt : "",
    };
  } catch {
    return null;
  }
}

function newOwner(): LockOwner {
  return {
    pid: process.pid,
    token: randomBytes(18).toString("base64url"),
    processIdentity: processIdentityForPid(process.pid),
    acquiredAt: new Date().toISOString(),
  };
}

function lockHandle(lockPath: string, owner: LockOwner): StateLock {
  return {
    path: lockPath,
    owner,
    release(): void {
      const current = readOwner(lockPath);
      if (current?.token !== owner.token || current.pid !== owner.pid) return;
      fs.rmSync(lockPath, { recursive: true, force: true });
    },
  };
}

function createLock(lockPath: string, owner: LockOwner): StateLock | null {
  try {
    fs.mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  try {
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
    try {
      fs.chmodSync(path.join(lockPath, "owner.json"), 0o600);
    } catch {
      // best effort on platforms without chmod semantics
    }
    return lockHandle(lockPath, owner);
  } catch (error) {
    fs.rmSync(lockPath, { recursive: true, force: true });
    throw error;
  }
}

function checkContender(
  lockPath: string,
  malformedSince: number | null
): { malformedSince: number | null; reclaimToken?: string } {
  const current = readOwner(lockPath);
  if (!current) {
    const since = malformedSince ?? Date.now();
    if (Date.now() - since > 1_000) {
      throw new StateLockError(`Cannot establish ownership of state lock ${lockPath}.`, "LOCK_UNKNOWN");
    }
    return { malformedSince: since };
  }
  const state = processStateForPid(current.pid);
  if (state === "missing") return { malformedSince: null, reclaimToken: current.token };
  if (state === "unknown" || !current.processIdentity || processIdentityForPid(current.pid) !== current.processIdentity) {
    throw new StateLockError(`State lock ${lockPath} has unverifiable owner PID ${current.pid}.`, "LOCK_UNKNOWN");
  }
  return { malformedSince: null };
}

/** Reclaim only the exact dead lock directory we observed; never rm a path that raced with a new owner. */
function reclaimDeadLock(lockPath: string, token: string): boolean {
  const quarantine = `${lockPath}.reclaim-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    fs.renameSync(lockPath, quarantine);
  } catch {
    return false;
  }
  const moved = readOwner(quarantine);
  if (moved?.token !== token || processStateForPid(moved.pid) !== "missing") {
    try {
      if (!fs.existsSync(lockPath)) fs.renameSync(quarantine, lockPath);
    } catch {
      // Leave the state visible rather than deleting an owner we cannot verify.
    }
    throw new StateLockError(`State lock ${lockPath} changed while reclaiming it.`, "LOCK_UNKNOWN");
  }
  fs.rmSync(quarantine, { recursive: true, force: true });
  return true;
}

export function inspectStateLock(lockPath: string): StateLockStatus {
  if (!fs.existsSync(lockPath)) return { state: "free" };
  const owner = readOwner(lockPath);
  if (!owner) return { state: "unknown", reason: "lock owner metadata is missing or invalid" };
  const state = processStateForPid(owner.pid);
  if (state === "missing") return { state: "free" };
  if (state === "unknown") return { state: "unknown", reason: `owner PID ${owner.pid} cannot be inspected` };
  const identity = processIdentityForPid(owner.pid);
  if (!owner.processIdentity || !identity || owner.processIdentity !== identity) {
    return { state: "unknown", reason: `owner PID ${owner.pid} identity changed or cannot be verified` };
  }
  return { state: "held", owner };
}

/** Synchronous lock for short installation-state mutations. */
export function acquireStateLock(
  lockPath: string,
  options: { timeoutMs?: number; pollMs?: number } = {}
): StateLock {
  ensureDir(path.dirname(lockPath));
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollMs = options.pollMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  const owner = newOwner();
  let malformedSince: number | null = null;

  for (;;) {
    const lock = createLock(lockPath, owner);
    if (lock) return lock;
    const checked = checkContender(lockPath, malformedSince);
    malformedSince = checked.malformedSince;
    if (checked.reclaimToken) {
      if (reclaimDeadLock(lockPath, checked.reclaimToken)) continue;
      continue;
    }
    if (Date.now() >= deadline) throw new StateLockError(`State lock ${lockPath} is held by another process.`, "LOCKED");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs);
  }
}

/** Async equivalent used across network/process waits; it never blocks the event loop. */
export async function acquireStateLockAsync(
  lockPath: string,
  options: { timeoutMs?: number; pollMs?: number } = {}
): Promise<StateLock> {
  ensureDir(path.dirname(lockPath));
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollMs = options.pollMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  const owner = newOwner();
  let malformedSince: number | null = null;

  for (;;) {
    const lock = createLock(lockPath, owner);
    if (lock) return lock;
    const checked = checkContender(lockPath, malformedSince);
    malformedSince = checked.malformedSince;
    if (checked.reclaimToken) {
      if (reclaimDeadLock(lockPath, checked.reclaimToken)) continue;
      continue;
    }
    if (Date.now() >= deadline) throw new StateLockError(`State lock ${lockPath} is held by another process.`, "LOCKED");
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
