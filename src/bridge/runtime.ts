import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";

/**
 * Installation runtime state. `workspaceIds` is the allowlist snapshot used
 * for diagnostics; the registry remains the source of truth for routing.
 * `workspaceId`/`workspaceRoot` stay for old local callers and status output.
 */
export interface RuntimeState {
  service: string;
  version: string;
  workspaceId: string;
  workspaceRoot: string;
  workspaceIds?: string[];
  defaultWorkspaceId?: string | null;
  installationId?: string;
  pid: number;
  port: number;
  adminToken: string;
  publicUrl: string | null;
  startedAt: string;
}

export function installationRuntimeFile(): string {
  return path.join(ensureDir(path.join(getStateDir(), "runtime")), "installation.json");
}

/** Legacy per-workspace path retained so old daemons can be diagnosed/stopped. */
export function runtimeFile(workspaceId: string): string {
  return path.join(ensureDir(path.join(getStateDir(), "runtime")), `${workspaceId}.json`);
}

export function writeRuntimeState(state: RuntimeState): void {
  if (state.workspaceIds && state.workspaceIds.length > 0) {
    writeSecureJson(installationRuntimeFile(), state);
    return;
  }
  writeSecureJson(runtimeFile(state.workspaceId), state);
}

function readInstallationRuntime(): RuntimeState | null {
  return readJsonIfExists<RuntimeState>(installationRuntimeFile());
}

export function readRuntimeState(workspaceId: string): RuntimeState | null {
  // Prefer the installation runtime whenever it exists. Otherwise a stale
  // legacy per-workspace daemon could win and recreate the old one-root model.
  const installation = readInstallationRuntime();
  if (installation) return installation;
  return readJsonIfExists<RuntimeState>(runtimeFile(workspaceId));
}

export function clearRuntimeState(workspaceId: string): void {
  try {
    fs.rmSync(runtimeFile(workspaceId), { force: true });
  } catch {
    // ignore
  }
  const installation = readInstallationRuntime();
  if (installation && (!installation.workspaceIds || installation.workspaceIds.includes(workspaceId))) {
    try {
      fs.rmSync(installationRuntimeFile(), { force: true });
    } catch {
      // ignore
    }
  }
}

export interface HealthPayload {
  service: string;
  version: string;
  workspaceId: string;
  workspaceIds?: string[];
  defaultWorkspaceId?: string | null;
  status: string;
}

/** Probe a port and check whether a healthy c2c installation answers. */
export async function probeBridge(
  port: number,
  timeoutMs = 2000
): Promise<HealthPayload | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const body = (await response.json()) as HealthPayload;
    if (body.service !== SERVICE_NAME) return null;
    return body;
  } catch {
    return null;
  }
}

export type BridgeObservation =
  | { state: "healthy"; runtime: RuntimeState }
  | { state: "stopped"; runtime: RuntimeState | null; reason: "runtime_missing" | "pid_missing" | "workspace_unregistered" }
  | { state: "unknown"; runtime: RuntimeState | null; reason: "probe_failed" | "pid_unknown" | "workspace_mismatch" };

function observePid(pid: number): "present" | "missing" | "unknown" {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "present";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "missing" : "unknown";
  }
}

/**
 * Distinguish a dead bridge from a probe that simply failed. A live
 * installation can acquire another registered workspace without restarting;
 * the health response is therefore checked against `workspaceIds` too.
 */
export async function findBridgeObservation(workspaceId: string): Promise<BridgeObservation> {
  const runtime = readRuntimeState(workspaceId);
  if (!runtime) return { state: "stopped", runtime: null, reason: "runtime_missing" };

  const health = await probeBridge(runtime.port);
  if (health && (health.workspaceIds?.includes(workspaceId) || health.workspaceId === workspaceId)) {
    return { state: "healthy", runtime };
  }
  if (health) {
    if (runtime.workspaceIds && !runtime.workspaceIds.includes(workspaceId)) {
      return { state: "stopped", runtime, reason: "workspace_unregistered" };
    }
    return { state: "unknown", runtime, reason: "workspace_mismatch" };
  }

  const pid = observePid(runtime.pid);
  if (pid === "missing") return { state: "stopped", runtime, reason: "pid_missing" };
  return { state: "unknown", runtime, reason: pid === "unknown" ? "pid_unknown" : "probe_failed" };
}

export async function findLiveBridge(workspaceId: string): Promise<RuntimeState | null> {
  const observation = await findBridgeObservation(workspaceId);
  return observation.state === "healthy" ? observation.runtime : null;
}

export { SERVICE_NAME, VERSION };
