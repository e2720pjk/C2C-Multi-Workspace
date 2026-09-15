import fs from "node:fs";
import path from "node:path";
import { inspectStateLock } from "../config/lock.js";
import { readInstallationIdentity } from "../config/installation.js";
import { DEFAULT_PORT, ensureDir, getStateDir, readJsonStrict, writeSecureJson } from "../config/paths.js";
import { RUNTIME_BUILD_ID, RUNTIME_CONTRACT_ID, SERVICE_NAME, VERSION } from "../version.js";

/**
 * Installation runtime state. Legacy fields remain optional so old test and
 * embedded callers can still inspect a single-workspace runtime, but a normal
 * daemon always writes installationId, contractId, and ownerToken.
 */
export interface RuntimeState {
  service: string;
  version: string;
  workspaceId: string;
  workspaceRoot: string;
  workspaceIds?: string[];
  defaultWorkspaceId?: string | null;
  installationId?: string;
  contractId?: string;
  buildId?: string;
  ownerToken?: string;
  pid: number;
  port: number;
  adminToken: string;
  publicUrl: string | null;
  startedAt: string;
}

export function installationRuntimeFile(): string {
  return path.join(ensureDir(path.join(getStateDir(), "runtime")), "installation.json");
}

/** Legacy per-workspace path retained so old daemons can be diagnosed. */
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

interface RuntimeRead {
  state: "missing" | "valid" | "corrupt";
  runtime: RuntimeState | null;
}

function readRuntimeFile(file: string): RuntimeRead {
  if (!fs.existsSync(file)) return { state: "missing", runtime: null };
  try {
    const value = readJsonStrict<unknown>(file);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { state: "corrupt", runtime: null };
    }
    const runtime = value as Partial<RuntimeState>;
    const pid = runtime.pid;
    const port = runtime.port;
    if (
      typeof runtime.service !== "string" ||
      typeof runtime.version !== "string" ||
      typeof runtime.workspaceId !== "string" ||
      typeof runtime.workspaceRoot !== "string" ||
      typeof pid !== "number" ||
      !Number.isInteger(pid) ||
      pid <= 0 ||
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      port <= 0 ||
      port > 65535 ||
      typeof runtime.adminToken !== "string" ||
      runtime.adminToken.length === 0 ||
      !(runtime.publicUrl === null || typeof runtime.publicUrl === "string") ||
      typeof runtime.startedAt !== "string" ||
      (runtime.workspaceIds !== undefined && (!Array.isArray(runtime.workspaceIds) || !runtime.workspaceIds.every((id) => typeof id === "string"))) ||
      (runtime.defaultWorkspaceId !== undefined && runtime.defaultWorkspaceId !== null && typeof runtime.defaultWorkspaceId !== "string") ||
      (runtime.installationId !== undefined && typeof runtime.installationId !== "string") ||
      (runtime.contractId !== undefined && typeof runtime.contractId !== "string") ||
      (runtime.buildId !== undefined && typeof runtime.buildId !== "string") ||
      (runtime.ownerToken !== undefined && typeof runtime.ownerToken !== "string")
    ) {
      return { state: "corrupt", runtime: null };
    }
    return { state: "valid", runtime: { ...runtime, pid, port } as RuntimeState };
  } catch {
    return { state: "corrupt", runtime: null };
  }
}

function readInstallationRuntimeResult(): RuntimeRead {
  return readRuntimeFile(installationRuntimeFile());
}

function legacyRuntimeReads(): RuntimeRead[] {
  const dir = ensureDir(path.join(getStateDir(), "runtime"));
  let files: string[];
  try {
    files = fs.readdirSync(dir)
      .filter((name) => name.endsWith(".json") && name !== "installation.json")
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
  return files.map((file) => readRuntimeFile(file));
}

export function readInstallationRuntime(): RuntimeState | null {
  const result = readInstallationRuntimeResult();
  return result.state === "valid" ? result.runtime : null;
}

export function readRuntimeState(workspaceId: string): RuntimeState | null {
  const installation = readInstallationRuntimeResult();
  if (installation.state === "valid") return installation.runtime;
  if (installation.state === "corrupt") return null;
  const legacy = readRuntimeFile(runtimeFile(workspaceId));
  return legacy.state === "valid" ? legacy.runtime : null;
}

export function clearInstallationRuntime(): void {
  try {
    fs.rmSync(installationRuntimeFile(), { force: true });
  } catch {
    // ignore
  }
}

export function clearRuntimeState(workspaceId: string): void {
  try {
    fs.rmSync(runtimeFile(workspaceId), { force: true });
  } catch {
    // Legacy cleanup is intentionally scoped to the legacy file. An old
    // process must not delete a newer installation runtime it cannot own.
  }
}

export interface HealthPayload {
  service: string;
  version: string;
  workspaceId: string;
  workspaceIds?: string[];
  defaultWorkspaceId?: string | null;
  installationId?: string;
  contractId?: string;
  buildId?: string;
  pid?: number;
  port?: number;
  status: string;
}

/** Probe a port and check whether a healthy c2c installation answers. */
export async function probeBridge(
  port: number,
  timeoutMs = 2000
): Promise<HealthPayload | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<HealthPayload>;
    const pid = typeof body.pid === "number" ? body.pid : NaN;
    const boundPort = typeof body.port === "number" ? body.port : NaN;
    if (
      body.service !== SERVICE_NAME ||
      !Number.isInteger(pid) ||
      pid <= 0 ||
      !Number.isInteger(boundPort) ||
      boundPort <= 0 ||
      boundPort > 65535 ||
      (body.workspaceIds !== undefined &&
        (!Array.isArray(body.workspaceIds) || body.workspaceIds.some((id) => typeof id !== "string")))
    ) {
      return null;
    }
    return body as HealthPayload;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type BridgeObservation =
  | {
      state: "healthy";
      runtime: RuntimeState;
    }
  | {
      state: "stopped";
      runtime: RuntimeState | null;
      reason: "runtime_missing" | "pid_missing" | "workspace_unregistered";
    }
  | {
      state: "unknown";
      runtime: RuntimeState | null;
      reason:
        | "probe_failed"
        | "pid_unknown"
        | "workspace_mismatch"
        | "runtime_corrupt"
        | "ownership_conflict"
        | "contract_mismatch"
        | "build_mismatch"
        | "runtime_missing_but_bridge_alive";
    };

export interface ObservationOptions {
  expectedInstallationId?: string;
  expectedContractId?: string;
  expectedBuildId?: string;
}

function observePid(pid: number): "present" | "missing" | "unknown" {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "present";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "missing" : "unknown";
  }
}

function inspectRuntime(
  read: RuntimeRead,
  workspaceId: string | undefined,
  options: ObservationOptions
): Promise<BridgeObservation> {
  if (read.state === "missing") return Promise.resolve({ state: "stopped", runtime: null, reason: "runtime_missing" });
  if (read.state === "corrupt" || !read.runtime) {
    return Promise.resolve({ state: "unknown", runtime: null, reason: "runtime_corrupt" });
  }
  const runtime = read.runtime;
  if (runtime.ownerToken || runtime.installationId) {
    const owner = inspectStateLock(path.join(getStateDir(), "runtime", "installation-owner.lock"));
    if (owner.state === "unknown") {
      return Promise.resolve({ state: "unknown", runtime, reason: "ownership_conflict" });
    }
    if (owner.state === "held" && (owner.owner.pid !== runtime.pid || owner.owner.token !== runtime.ownerToken)) {
      return Promise.resolve({ state: "unknown", runtime, reason: "ownership_conflict" });
    }
    if (owner.state === "free" && observePid(runtime.pid) !== "missing") {
      return Promise.resolve({ state: "unknown", runtime, reason: "ownership_conflict" });
    }
  }
  if (options.expectedInstallationId && runtime.installationId && runtime.installationId !== options.expectedInstallationId) {
    return Promise.resolve({ state: "unknown", runtime, reason: "ownership_conflict" });
  }
  if (options.expectedContractId && runtime.contractId && runtime.contractId !== options.expectedContractId) {
    return Promise.resolve({ state: "unknown", runtime, reason: "contract_mismatch" });
  }
  if (options.expectedBuildId && runtime.buildId && runtime.buildId !== options.expectedBuildId) {
    return Promise.resolve({ state: "unknown", runtime, reason: "build_mismatch" });
  }

  return probeBridge(runtime.port).then((health) => {
    if (health) {
      if (health.pid !== runtime.pid || health.port !== runtime.port) {
        return { state: "unknown", runtime, reason: "ownership_conflict" };
      }
      if (runtime.ownerToken || runtime.installationId) {
        const ownerAfterProbe = inspectStateLock(path.join(getStateDir(), "runtime", "installation-owner.lock"));
        if (
          ownerAfterProbe.state !== "held" ||
          ownerAfterProbe.owner.pid !== runtime.pid ||
          ownerAfterProbe.owner.token !== runtime.ownerToken
        ) {
          return { state: "unknown", runtime, reason: "ownership_conflict" };
        }
      }
      if (runtime.installationId && health.installationId !== runtime.installationId) {
        return { state: "unknown", runtime, reason: "ownership_conflict" };
      }
      if (options.expectedInstallationId && health.installationId !== options.expectedInstallationId) {
        return { state: "unknown", runtime, reason: "ownership_conflict" };
      }
      if (runtime.contractId && health.contractId !== runtime.contractId) {
        return { state: "unknown", runtime, reason: "contract_mismatch" };
      }
      if (options.expectedContractId && health.contractId !== options.expectedContractId) {
        return { state: "unknown", runtime, reason: "contract_mismatch" };
      }
      if (runtime.buildId && health.buildId !== runtime.buildId) {
        return { state: "unknown", runtime, reason: "build_mismatch" };
      }
      if (options.expectedBuildId && health.buildId !== options.expectedBuildId) {
        return { state: "unknown", runtime, reason: "build_mismatch" };
      }
      if (health.pid !== undefined && health.pid !== runtime.pid) {
        return { state: "unknown", runtime, reason: "ownership_conflict" };
      }
      if (
        workspaceId &&
        !(health.workspaceIds?.includes(workspaceId) || health.workspaceId === workspaceId)
      ) {
        return health.workspaceIds
          ? { state: "stopped", runtime, reason: "workspace_unregistered" }
          : { state: "unknown", runtime, reason: "workspace_mismatch" };
      }
      const observedRuntime: RuntimeState = health.workspaceIds
        ? {
            ...runtime,
            workspaceId: health.workspaceId,
            workspaceIds: [...health.workspaceIds],
            defaultWorkspaceId: health.defaultWorkspaceId,
            installationId: health.installationId ?? runtime.installationId,
            contractId: health.contractId ?? runtime.contractId,
            buildId: health.buildId ?? runtime.buildId,
          }
        : runtime;
      return { state: "healthy", runtime: observedRuntime };
    }

    const pid = observePid(runtime.pid);
    if (pid === "missing") return { state: "stopped", runtime, reason: "pid_missing" };
    return { state: "unknown", runtime, reason: pid === "unknown" ? "pid_unknown" : "probe_failed" };
  });
}

async function missingInstallationObservation(): Promise<BridgeObservation> {
  const owner = inspectStateLock(path.join(getStateDir(), "runtime", "installation-owner.lock"));
  if (owner.state === "held" || owner.state === "unknown") {
    return { state: "unknown", runtime: null, reason: "ownership_conflict" };
  }
  let lastPort: number | null = null;
  try {
    lastPort = readInstallationIdentity()?.lastPort ?? null;
  } catch {
    return { state: "unknown", runtime: null, reason: "ownership_conflict" };
  }
  // A deleted runtime file must not turn a listener on a previously-owned
  // port into permission to start a second daemon. A first installation has
  // no port hint and can still start normally.
  const ports = [...new Set([lastPort, DEFAULT_PORT].filter((port): port is number => port !== null))];
  for (const port of ports) {
    if (await probeBridge(port)) {
      return { state: "unknown", runtime: null, reason: "runtime_missing_but_bridge_alive" };
    }
  }
  return { state: "stopped", runtime: null, reason: "runtime_missing" };
}

async function findLegacyObservation(
  workspaceId: string | undefined,
  options: ObservationOptions
): Promise<BridgeObservation | null> {
  for (const legacy of legacyRuntimeReads()) {
    if (legacy.state === "corrupt") return inspectRuntime(legacy, workspaceId, options);
    if (legacy.state === "valid") {
      const observation = await inspectRuntime(legacy, workspaceId, options);
      if (observation.state !== "stopped") return observation;
    }
  }
  return null;
}

export async function findBridgeObservation(
  workspaceId: string,
  options: ObservationOptions = {}
): Promise<BridgeObservation> {
  const installation = readInstallationRuntimeResult();
  if (installation.state !== "missing") return inspectRuntime(installation, workspaceId, options);
  const legacy = readRuntimeFile(runtimeFile(workspaceId));
  if (legacy.state !== "missing") return inspectRuntime(legacy, workspaceId, options);
  return (await findLegacyObservation(workspaceId, options)) ?? missingInstallationObservation();
}

export async function findInstallationObservation(
  workspaceId?: string,
  options: ObservationOptions = {}
): Promise<BridgeObservation> {
  const installation = readInstallationRuntimeResult();
  if (installation.state !== "missing") return inspectRuntime(installation, workspaceId, options);
  return (await findLegacyObservation(workspaceId, options)) ?? missingInstallationObservation();
}

export async function findLiveBridge(
  workspaceId: string,
  options: ObservationOptions = {}
): Promise<RuntimeState | null> {
  const observation = await findBridgeObservation(workspaceId, options);
  return observation.state === "healthy" ? observation.runtime : null;
}

export { RUNTIME_BUILD_ID, RUNTIME_CONTRACT_ID, SERVICE_NAME, VERSION };
