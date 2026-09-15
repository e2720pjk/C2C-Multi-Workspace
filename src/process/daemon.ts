import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireStateLockAsync,
  inspectStateLock,
  processStateForPid,
  type StateLock,
} from "../config/lock.js";
import { ensureInstallationIdentity, readInstallationIdentity } from "../config/installation.js";
import { ensureDir, getStateDir } from "../config/paths.js";
import {
  findInstallationObservation,
  clearInstallationRuntime,
  findLiveBridge,
  probeBridge,
  readInstallationRuntime,
  readRuntimeState,
  type RuntimeState,
} from "../bridge/runtime.js";
import { RUNTIME_BUILD_ID, RUNTIME_CONTRACT_ID, SERVICE_NAME } from "../version.js";
import { Workspace } from "../workspace/manager.js";
import { WorkspaceRegistry } from "../workspace/registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Path to the CLI entry, works from dist/ and from tsx dev runs. */
function cliEntry(): { cmd: string; args: string[] } {
  const distEntry = path.resolve(__dirname, "..", "cli", "index.js");
  const runningSource = path.basename(path.dirname(__dirname)) === "src";
  if (!runningSource && fs.existsSync(distEntry)) {
    return { cmd: process.execPath, args: [distEntry] };
  }
  // Dev fallback: run the same TypeScript sources instead of silently mixing a
  // stale dist build with the current CLI checkout.
  const projectRoot = path.resolve(__dirname, "..", "..");
  const tsEntry = path.join(projectRoot, "src", "cli", "index.ts");
  return { cmd: process.execPath, args: ["--import", "tsx/esm", tsEntry] };
}

function startupLockFile(): string {
  return path.join(getStateDir(), "runtime", "installation-start.lock");
}

/** Serialize installation mutations with daemon startup without adding another lifecycle lock. */
export async function withInstallationStartupLock<T>(operation: (lock: StateLock) => Promise<T>): Promise<T> {
  const lock = await acquireStateLockAsync(startupLockFile(), { timeoutMs: 35_000 });
  try {
    return await operation(lock);
  } finally {
    lock.release();
  }
}

function ownerLockFile(): string {
  return path.join(getStateDir(), "runtime", "installation-owner.lock");
}

function expectedIdentity(identity: ReturnType<typeof readInstallationIdentity>): {
  expectedInstallationId: string;
  expectedContractId: string;
  expectedBuildId: string;
} {
  if (!identity) throw new Error("C2C installation identity is unavailable.");
  return {
    expectedInstallationId: identity.installationId,
    expectedContractId: RUNTIME_CONTRACT_ID,
    expectedBuildId: RUNTIME_BUILD_ID,
  };
}

export interface EnsureBridgeResult {
  runtime: RuntimeState;
  spawned: boolean;
}

async function refreshInstallationRuntime(runtime: RuntimeState): Promise<RuntimeState> {
  const info = await adminFetch<{
    workspaceId?: string;
    workspaceIds?: string[];
    defaultWorkspaceId?: string | null;
  }>(runtime, "GET", "/admin/info");
  const current = readInstallationRuntime() ?? runtime;
  return {
    ...current,
    workspaceId: info.workspaceId ?? current.workspaceId,
    workspaceIds: info.workspaceIds ?? current.workspaceIds,
    defaultWorkspaceId:
      info.defaultWorkspaceId !== undefined ? info.defaultWorkspaceId : current.defaultWorkspaceId,
  };
}

/**
 * Ensure one installation daemon is running. The startup lock serializes the
 * check-and-spawn window; the daemon itself holds a separate owner lock for
 * its whole lifetime, so a port race cannot create a second installation.
 */
export async function ensureBridge(
  workspaceRoot: string,
  opts: { port?: number } = {}
): Promise<EnsureBridgeResult> {
  const workspace = new Workspace(workspaceRoot);
  const registry = new WorkspaceRegistry();
  const registered = registry.register(workspace.root);
  if (!registered.enabled) registry.setEnabled(registered.workspaceId, true);
  // One caller may spend up to 20s waiting for the child to become healthy;
  // let concurrent `c2c start` callers wait for that result instead of racing.
  const startupLock = await acquireStateLockAsync(startupLockFile(), { timeoutMs: 35_000 });
  try {
    // Do not mint a replacement identity while a live daemon may still own the
    // old one. That would turn a damaged state file into an identity split.
    let identity = readInstallationIdentity();
    let observation = await findInstallationObservation(workspace.id, identity ? {
      expectedInstallationId: identity.installationId,
      expectedContractId: RUNTIME_CONTRACT_ID,
      expectedBuildId: RUNTIME_BUILD_ID,
    } : {});
    if (observation.state === "healthy") {
      if (!identity) throw new Error("C2C installation identity is missing; refusing to reuse the running daemon.");
      return { runtime: await refreshInstallationRuntime(observation.runtime), spawned: false };
    }
    if (observation.state === "unknown") {
      if (observation.reason === "build_mismatch" && observation.runtime && identity) {
        await shutdownOwnedRuntime(observation.runtime, identity.installationId);
        observation = await findInstallationObservation(workspace.id, {
          expectedInstallationId: identity.installationId,
          expectedContractId: RUNTIME_CONTRACT_ID,
          expectedBuildId: RUNTIME_BUILD_ID,
        });
      }
      if (observation.state === "unknown") {
        throw new Error(
          `Bridge state is uncertain (${observation.reason}); refusing to start another bridge.`
        );
      }
    }
    const owner = inspectStateLock(ownerLockFile());
    if (owner.state === "held") {
      throw new Error(`Bridge state is uncertain (installation owner PID ${owner.owner.pid} is starting or running).`);
    }
    if (owner.state === "unknown") {
      throw new Error(`Bridge state is uncertain (${owner.reason}); refusing to start another bridge.`);
    }
    identity ??= ensureInstallationIdentity();
    const expected = expectedIdentity(identity);
    observation = await findInstallationObservation(workspace.id, expected);
    if (observation.state === "healthy") {
      return { runtime: await refreshInstallationRuntime(observation.runtime), spawned: false };
    }
    if (observation.state === "unknown") {
      if (observation.reason === "build_mismatch" && observation.runtime) {
        await shutdownOwnedRuntime(observation.runtime, identity.installationId);
        observation = await findInstallationObservation(workspace.id, expected);
      }
      if (observation.state === "unknown") {
        throw new Error(
          `Bridge state is uncertain (${observation.reason}); refusing to start another bridge.`
        );
      }
    }

    const logDir = ensureDir(path.join(getStateDir(), "logs"));
    const logFile = path.join(logDir, "bridge-installation.out.log");
    const out = fs.openSync(logFile, "a", 0o600);
    try {
      fs.chmodSync(logFile, 0o600);
    } catch {
      // Windows / filesystems without chmod semantics
    }
    const { cmd, args } = cliEntry();
    const child = spawn(
      cmd,
      [...args, "serve", "--workspace", workspace.root, ...(opts.port !== undefined ? ["--port", String(opts.port)] : [])],
      {
        detached: true,
        stdio: ["ignore", out, out],
        env: { ...process.env },
        windowsHide: true,
      }
    );
    let spawnErrorMessage: string | null = null;
    child.once("error", (error) => {
      spawnErrorMessage = error.message;
    });
    child.unref();
    fs.closeSync(out);

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (spawnErrorMessage) throw new Error(`Bridge process could not start: ${spawnErrorMessage}. See ${logFile}`);
      const runtime = await findLiveBridge(workspace.id, expected);
      if (runtime) return { runtime, spawned: true };
      if (child.exitCode !== null) {
        throw new Error(`Bridge process exited with code ${child.exitCode}. See ${logFile}`);
      }
    }
    throw new Error(`Bridge did not become healthy within 20s. See ${logFile}`);
  } finally {
    startupLock.release();
  }
}

export async function adminFetch<T = unknown>(
  runtime: RuntimeState,
  method: "GET" | "POST",
  route: string,
  timeoutMs = 60_000
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
      method,
      headers: { Authorization: `Bearer ${runtime.adminToken}` },
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => ({}))) as T & { message?: string };
    if (!response.ok) {
      throw new Error((body as { message?: string }).message ?? `Admin request failed (${response.status})`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

interface AdminRuntimeProof {
  service?: string;
  installationId?: string;
  contractId?: string;
  buildId?: string;
  pid?: number;
  port?: number;
}

/**
 * Build compatibility is a reuse check, not an ownership check. This proof
 * deliberately ignores the expected build while requiring every independent
 * ownership signal before asking an older daemon to shut itself down.
 */
async function proveOwnedRuntimeForShutdown(
  runtime: RuntimeState,
  installationId: string
): Promise<void> {
  if (
    runtime.installationId !== installationId ||
    !runtime.ownerToken ||
    !runtime.adminToken ||
    !runtime.buildId ||
    !runtime.contractId
  ) {
    throw new Error("Bridge ownership cannot be proved from the canonical runtime state.");
  }
  const owner = inspectStateLock(ownerLockFile());
  if (owner.state === "unknown") {
    throw new Error(`Bridge ownership cannot be proved (${owner.reason}).`);
  }
  if (
    owner.state !== "held" ||
    owner.owner.pid !== runtime.pid ||
    owner.owner.token !== runtime.ownerToken ||
    (runtime.processIdentity !== undefined && runtime.processIdentity !== owner.owner.processIdentity)
  ) {
    throw new Error("Bridge ownership cannot be proved from the installation owner lease.");
  }

  const observed = await findInstallationObservation(undefined, {
    expectedInstallationId: installationId,
    expectedContractId: runtime.contractId,
  });
  if (observed.state !== "healthy" || observed.runtime.pid !== runtime.pid) {
    throw new Error(
      `Bridge ownership cannot be proved from runtime/health consistency (${observed.state}${observed.state === "unknown" ? `: ${observed.reason}` : ""}).`
    );
  }

  let info: AdminRuntimeProof;
  try {
    info = await adminFetch<AdminRuntimeProof>(runtime, "GET", "/admin/info", 5_000);
  } catch (error) {
    throw new Error(`Bridge admin authority cannot be verified: ${(error as Error).message}`);
  }
  if (
    info.service !== SERVICE_NAME ||
    info.installationId !== installationId ||
    info.contractId !== runtime.contractId ||
    info.buildId !== runtime.buildId ||
    info.pid !== runtime.pid ||
    info.port !== runtime.port
  ) {
    throw new Error("Bridge admin authority does not match the canonical runtime state.");
  }
  if (!owner.owner.processIdentity) {
    throw new Error("Bridge owner process identity cannot be verified.");
  }
}

async function shutdownOwnedRuntime(runtime: RuntimeState, installationId: string): Promise<void> {
  await proveOwnedRuntimeForShutdown(runtime, installationId);
  await adminFetch(runtime, "POST", "/admin/shutdown", 5_000);

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const owner = inspectStateLock(ownerLockFile());
    if (owner.state === "unknown") {
      throw new Error(`Bridge shutdown ownership became unverifiable (${owner.reason}).`);
    }
    if (
      owner.state === "held" &&
      (owner.owner.pid !== runtime.pid || owner.owner.token !== runtime.ownerToken)
    ) {
      throw new Error("A different process acquired the installation owner lease during shutdown.");
    }
    if (owner.state === "held") {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }

    const current = readInstallationRuntime();
    if (current) {
      if (current.pid !== runtime.pid || current.ownerToken !== runtime.ownerToken) {
        throw new Error("Canonical runtime state changed to an unverifiable owner during shutdown.");
      }
      const processState = processStateForPid(runtime.pid);
      if (processState === "unknown") {
        throw new Error("Bridge PID identity became unverifiable during shutdown.");
      }
      if (processState === "present") {
        const health = await probeBridge(runtime.port);
        if (health?.pid === runtime.pid) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        throw new Error("Bridge owner lease was released while the daemon process remained alive.");
      }
      clearInstallationRuntime();
      return;
    }

    // The authenticated daemon has released its lease and removed the
    // canonical runtime. Do not kill or infer ownership from a PID that may
    // already be a zombie/reused process; a live C2C response on the port is
    // the only remaining overlap signal.
    const health = await probeBridge(runtime.port);
    if (health?.pid === runtime.pid && health.installationId === installationId) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    if (health?.pid === runtime.pid && health.installationId !== installationId) {
      throw new Error("Bridge port still serves a different installation after shutdown.");
    }
    return;
  }
  throw new Error("Bridge did not finish graceful shutdown within 10s.");
}

/** Stop the installation, never merely the workspace named by the cwd. */
async function stopBridgeImpl(_workspaceRoot?: string): Promise<boolean> {
  let identity: ReturnType<typeof readInstallationIdentity> = null;
  try {
    identity = readInstallationIdentity();
  } catch (error) {
    throw new Error((error as Error).message);
  }
  // Stop is installation-scoped; a removed/disabled cwd must not prevent it.
  const workspaceId = undefined;
  const runtime = readInstallationRuntime();
  if (runtime?.installationId && !identity) {
    throw new Error("C2C installation identity is missing while a daemon is running; refusing to stop it.");
  }
  const observation = await findInstallationObservation(workspaceId, {
    expectedInstallationId: identity?.installationId,
    expectedContractId: RUNTIME_CONTRACT_ID,
    expectedBuildId: RUNTIME_BUILD_ID,
  });
  if (observation.state === "stopped") {
    if (observation.reason === "runtime_missing") {
      const owner = inspectStateLock(ownerLockFile());
      if (owner.state !== "free") {
        throw new Error(`Bridge state is uncertain (installation owner ${owner.state}); refusing to stop an unverifiable process.`);
      }
      return false;
    }
    if (observation.reason === "pid_missing") return false;
    throw new Error(`Bridge state is stopped but not safely attributable (${observation.reason}).`);
  }
  if (observation.state === "unknown") {
    if (observation.reason === "build_mismatch" && observation.runtime && identity) {
      try {
        await shutdownOwnedRuntime(observation.runtime, identity.installationId);
        return true;
      } catch (error) {
        throw new Error(`Bridge is owned by this installation but graceful shutdown failed: ${(error as Error).message}`);
      }
    }
    throw new Error(
      `Bridge state is uncertain (${observation.reason}); refusing to terminate an unverifiable process.`
    );
  }

  try {
    await shutdownOwnedRuntime(observation.runtime, identity?.installationId ?? "");
    return true;
  } catch (error) {
    throw new Error(`Bridge is owned by this installation but graceful shutdown failed: ${(error as Error).message}`);
  }
}

/** Stop serializes with startup so a concurrent start cannot reuse a daemon mid-shutdown. */
export async function stopBridge(workspaceRoot?: string, heldStartupLock?: StateLock): Promise<boolean> {
  const lock = heldStartupLock ?? (await acquireStateLockAsync(startupLockFile(), { timeoutMs: 35_000 }));
  try {
    return await stopBridgeImpl(workspaceRoot);
  } finally {
    if (!heldStartupLock) lock.release();
  }
}

/** Used by status/doctor callers that need the current installation runtime. */
export function installationRuntime(): RuntimeState | null {
  return readInstallationRuntime() ?? null;
}

/** Keep the import contract for callers that only need a health probe. */
export { findInstallationObservation, probeBridge, readRuntimeState };
