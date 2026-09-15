import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  acquireStateLockAsync,
  inspectStateLock,
  processIdentityForPid,
  processStateForPid,
  type StateLock,
} from "../config/lock.js";
import { ensureDir, getStateDir, readJsonStrict, writeSecureJson } from "../config/paths.js";
import type { Logger } from "../logger/index.js";
import { nullLogger } from "../logger/index.js";
import { findBinary } from "./detect.js";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "./provider.js";

const TUNNEL_ID_RE = /^tunnel_[a-f0-9]{32}$/;
const DEFAULT_START_TIMEOUT_MS = 15_000;
const DEFAULT_RECOVERY_LIMIT = 3;

type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
type ReadyProbe = (baseUrl: string) => Promise<boolean>;

interface SavedTunnelProcess {
  pid: number;
  processIdentity: string;
  tunnelId: string;
}

export interface TunnelAuthorization {
  value: string;
  expiresAt: number;
}

export interface OpenAiSecureTunnelOptions {
  logger?: Logger;
  tunnelId?: string;
  apiKey?: string;
  binaryPath?: string;
  stateDir?: string;
  startTimeoutMs?: number;
  recoveryLimit?: number;
  binaryResolver?: () => string | null;
  spawnProcess?: SpawnProcess;
  readyProbe?: ReadyProbe;
  controlPlaneBaseUrl?: string;
  /** Optional short-lived bearer used for the local MCP binding. */
  mcpAuthorization?: () => TunnelAuthorization | Promise<TunnelAuthorization>;
  /** Revoke the bearer when an unexpected child exit invalidates its channel. */
  onAuthorizationInvalidated?: () => void | Promise<void>;
  /** Retire the previous bearer only after its replacement child is ready. */
  onAuthorizationReplaced?: () => void | Promise<void>;
}

function defaultReadyProbe(baseUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_000);
  return fetch(`${baseUrl}/readyz`, { signal: controller.signal })
    .then((response) => response.ok)
    .catch(() => false)
    .finally(() => clearTimeout(timer));
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("tunnel-client health URL must use HTTP(S)");
  return url.href.replace(/\/$/, "");
}

/**
 * Integration layer for the official OpenAI tunnel-client binary.
 *
 * The API key is passed to the child through CONTROL_PLANE_API_KEY and only
 * referenced by the official `env:` flag; it is never put in C2C state or
 * command-line arguments. The provider has one installation lock and one
 * child at a time, independent of workspace routing.
 */
export class OpenAiSecureTunnel implements TunnelProvider {
  readonly name = "openai-secure";

  private readonly logger: Logger;
  private readonly options: OpenAiSecureTunnelOptions;
  private readonly healthDir: string;
  private readonly lockPath: string;
  private readonly processStateFile: string;
  private readonly startTimeoutMs: number;
  private readonly recoveryLimit: number;
  private child: ChildProcess | null = null;
  private healthUrl: string | null = null;
  private localPort: number | null = null;
  private ownerLock: StateLock | null = null;
  private lifecycle: Promise<unknown> = Promise.resolve();
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryAttempts = 0;
  private authorizationTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private stopRequested = false;
  private lastError: string | null = null;
  private activeTunnelId: string | null = null;
  private activeApiKeyDigest: string | null = null;
  private activeAuthorizationDigest: string | null = null;
  private activeAuthorizationExpiresAt: number | null = null;
  private authorizationError: string | null = null;

  constructor(options: OpenAiSecureTunnelOptions = {}) {
    this.options = options;
    this.logger = options.logger ?? nullLogger;
    const stateDir = options.stateDir ?? getStateDir();
    this.healthDir = ensureDir(path.join(stateDir, "tunnel-client"));
    this.lockPath = path.join(stateDir, "runtime", "openai-tunnel-owner.lock");
    this.processStateFile = path.join(this.healthDir, "process.json");
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.recoveryLimit = options.recoveryLimit ?? DEFAULT_RECOVERY_LIMIT;
  }

  private credentials(): { tunnelId: string; apiKey: string } {
    const tunnelId = (this.options.tunnelId?.trim() || process.env.CONTROL_PLANE_TUNNEL_ID?.trim() || "").trim();
    const apiKey = (this.options.apiKey?.trim() || process.env.CONTROL_PLANE_API_KEY?.trim() || "").trim();
    if (!tunnelId || !TUNNEL_ID_RE.test(tunnelId)) {
      throw new Error("NEED_OPENAI_TUNNEL_ID: set CONTROL_PLANE_TUNNEL_ID to an existing tunnel id.");
    }
    if (!apiKey) {
      throw new Error("NEED_OPENAI_TUNNEL_KEY: set CONTROL_PLANE_API_KEY for tunnel-client runtime use.");
    }
    return { tunnelId, apiKey };
  }

  private binary(): string | null {
    if (this.options.binaryPath !== undefined) {
      try {
        if (!fs.statSync(this.options.binaryPath).isFile()) return null;
        fs.accessSync(this.options.binaryPath, fs.constants.F_OK | fs.constants.X_OK);
        return this.options.binaryPath;
      } catch {
        return null;
      }
    }
    return this.options.binaryResolver?.() ?? findBinary("tunnel-client");
  }

  private apiKeyDigest(apiKey: string): string {
    return createHash("sha256").update(apiKey).digest("hex");
  }

  private connectorUrl(tunnelId: string): string {
    const base = this.options.controlPlaneBaseUrl ?? process.env.CONTROL_PLANE_BASE_URL ?? "https://api.openai.com";
    const url = new URL(base.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("CONTROL_PLANE_BASE_URL must use HTTP(S)");
    }
    return `${url.href.replace(/\/$/, "")}/v1/mcp/${tunnelId}`;
  }

  private args(localPort: number, healthUrlFile: string, tunnelId: string, withAuthorization: boolean): string[] {
    const args = [
      "run",
      "--control-plane.tunnel-id",
      tunnelId,
      "--control-plane.api-key=env:CONTROL_PLANE_API_KEY",
      "--mcp.server-url",
      `channel=main,url=http://127.0.0.1:${localPort}/mcp`,
      "--mcp.startup-wait-timeout",
      "30s",
    ];
    if (withAuthorization) args.push("--mcp.extra-headers", "Authorization: env:C2C_MCP_AUTHORIZATION");
    args.push(
      "--health.listen-addr",
      "127.0.0.1:0",
      "--health.url-file",
      healthUrlFile,
    );
    return args;
  }

  private async authorization(): Promise<TunnelAuthorization | null> {
    if (!this.options.mcpAuthorization) return null;
    const authorization = await this.options.mcpAuthorization();
    if (!authorization.value || !Number.isFinite(authorization.expiresAt) || authorization.expiresAt <= Date.now()) {
      throw new Error("OpenAI tunnel MCP authorization is missing or expired.");
    }
    return authorization;
  }

  private isAuthorizationHealthy(): boolean {
    if (!this.options.mcpAuthorization) return true;
    return Boolean(
      this.activeAuthorizationDigest &&
        this.activeAuthorizationExpiresAt &&
        this.activeAuthorizationExpiresAt > Date.now() &&
        !this.authorizationError
    );
  }

  private scheduleAuthorizationRefresh(expiresAt: number): void {
    if (this.authorizationTimer) clearTimeout(this.authorizationTimer);
    // Schedule inside the provider's 30s refresh window, with a 1s margin so
    // timer jitter cannot leave start() returning the still-current bearer.
    const delay = Math.max(10, expiresAt - Date.now() - 29_000);
    this.authorizationTimer = setTimeout(() => {
      this.authorizationTimer = null;
      void this.refreshAuthorization(expiresAt);
    }, delay);
  }

  private scheduleAuthorizationRetry(expiresAt: number): void {
    if (this.authorizationTimer) clearTimeout(this.authorizationTimer);
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      void this.expireAuthorization();
      return;
    }
    this.authorizationTimer = setTimeout(() => {
      this.authorizationTimer = null;
      void this.refreshAuthorization(expiresAt);
    }, Math.min(1_000, Math.max(100, remaining - 1_000)));
  }

  private async refreshAuthorization(expiresAt: number): Promise<void> {
    if (this.stopping || this.localPort === null) return;
    const port = this.localPort;
    try {
      await this.start(port);
      return;
    } catch (error) {
      const message = (error as Error).message;
      this.authorizationError = message;
      this.lastError = message;
      this.logger.warn(`OpenAI tunnel authorization refresh failed: ${message}`);
      if (this.localPort === null && !this.child) this.localPort = port;
      if (!this.stopping && this.localPort !== null && Date.now() < expiresAt) {
        this.scheduleAuthorizationRetry(expiresAt);
      } else if (!this.stopping) {
        void this.expireAuthorization();
      }
    }
  }

  private async expireAuthorization(): Promise<void> {
    if (this.stopping || !this.child) return;
    const message = "OpenAI tunnel MCP authorization expired before its replacement became ready.";
    this.authorizationError = message;
    this.lastError = message;
    try {
      await this.stop();
      await this.options.onAuthorizationInvalidated?.();
    } catch (error) {
      this.lastError = `${message} ${(error as Error).message}`;
      this.logger.error(`OpenAI tunnel authorization shutdown failed: ${this.lastError}`);
    }
  }

  private async readReadyUrl(file: string): Promise<string | null> {
    try {
      const raw = fs.readFileSync(file, "utf8").trim();
      if (!raw) return null;
      const baseUrl = normalizeBaseUrl(raw);
      return (await (this.options.readyProbe ?? defaultReadyProbe)(baseUrl)) ? baseUrl : null;
    } catch {
      return null;
    }
  }

  private async waitForReady(child: ChildProcess, file: string): Promise<string> {
    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      if (this.child !== child || this.stopping) throw new Error("tunnel-client exited during startup");
      const baseUrl = await this.readReadyUrl(file);
      if (baseUrl) return baseUrl;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("tunnel-client did not become ready within the startup timeout");
  }

  private clearProcessState(pid?: number): void {
    try {
      const saved = readJsonStrict<SavedTunnelProcess>(this.processStateFile);
      if (!saved || pid === undefined || saved.pid === pid) fs.rmSync(this.processStateFile, { force: true });
    } catch {
      // A malformed orphan record is handled by reapSavedProcess on the next start.
    }
  }

  private releaseIdleOwner(): void {
    if (this.child || fs.existsSync(this.processStateFile)) return;
    this.ownerLock?.release();
    this.ownerLock = null;
  }

  private async reapSavedProcess(): Promise<void> {
    if (!fs.existsSync(this.processStateFile)) return;
    let saved: SavedTunnelProcess | null;
    try {
      saved = readJsonStrict<SavedTunnelProcess>(this.processStateFile);
    } catch {
      throw new Error("OPENAI_TUNNEL_CONFLICT: tunnel-client process state is corrupt; refusing to start another client.");
    }
    if (!saved) {
      throw new Error("OPENAI_TUNNEL_CONFLICT: tunnel-client process state is empty; refusing to start another client.");
    }
    if (!Number.isInteger(saved.pid) || saved.pid <= 0 || !saved.processIdentity || !TUNNEL_ID_RE.test(saved.tunnelId)) {
      throw new Error("OPENAI_TUNNEL_CONFLICT: tunnel-client process state is invalid; refusing to start another client.");
    }
    if (saved.pid === process.pid) {
      throw new Error("OPENAI_TUNNEL_CONFLICT: tunnel-client process state points at the C2C daemon.");
    }
    const state = processStateForPid(saved.pid);
    if (state === "unknown") {
      throw new Error("OPENAI_TUNNEL_CONFLICT: cannot verify the previous tunnel-client process.");
    }
    if (state === "present" && processIdentityForPid(saved.pid) !== saved.processIdentity) {
      throw new Error("OPENAI_TUNNEL_CONFLICT: tunnel-client PID was reused; refusing to terminate it.");
    }
    const sameProcess = (): boolean => {
      return processStateForPid(saved!.pid) === "present" && processIdentityForPid(saved!.pid) === saved!.processIdentity;
    };
    if (state === "present") {
      if (!sameProcess()) {
        throw new Error("OPENAI_TUNNEL_CONFLICT: tunnel-client PID was reused; refusing to terminate it.");
      }
      process.kill(saved.pid, "SIGTERM");
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const current = processStateForPid(saved.pid);
        if (current === "missing") break;
        const identity = processIdentityForPid(saved.pid);
        if (identity && identity !== saved.processIdentity) {
          throw new Error("OPENAI_TUNNEL_CONFLICT: tunnel-client PID changed while stopping it.");
        }
        // A terminating process can briefly lose inspectable identity before
        // the kernel reports ESRCH. Wait; never turn that uncertainty into a kill.
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (sameProcess()) process.kill(saved.pid, "SIGKILL");
      const killDeadline = Date.now() + 2_000;
      while (Date.now() < killDeadline && processStateForPid(saved.pid) !== "missing") {
        const identity = processIdentityForPid(saved.pid);
        if (identity && identity !== saved.processIdentity) {
          throw new Error("OPENAI_TUNNEL_CONFLICT: tunnel-client PID changed after SIGKILL.");
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (processStateForPid(saved.pid) !== "missing") {
        throw new Error("OPENAI_TUNNEL_CONFLICT: previous tunnel-client did not stop safely.");
      }
    }
    fs.rmSync(this.processStateFile, { force: true });
  }

  private saveProcessState(child: ChildProcess, tunnelId: string): void {
    if (!child.pid) throw new Error("Official tunnel-client did not expose a process id.");
    const processIdentity = processIdentityForPid(child.pid);
    if (!processIdentity) throw new Error("Cannot verify the official tunnel-client process identity.");
    writeSecureJson(this.processStateFile, { pid: child.pid, processIdentity, tunnelId } satisfies SavedTunnelProcess);
  }

  private attachChild(child: ChildProcess): void {
    this.child = child;
    child.once("error", (error) => {
      this.lastError = error.message;
      this.logger.warn(`OpenAI tunnel-client process error: ${error.message}`);
      if (this.child === child) {
        this.child = null;
        this.healthUrl = null;
        this.activeTunnelId = null;
        this.activeApiKeyDigest = null;
        this.activeAuthorizationDigest = null;
        this.activeAuthorizationExpiresAt = null;
        if (this.authorizationTimer) clearTimeout(this.authorizationTimer);
        this.authorizationTimer = null;
        this.clearProcessState(child.pid);
        if (!this.stopping) {
          void Promise.resolve(this.options.onAuthorizationInvalidated?.()).catch((error: Error) => {
            this.logger.warn(`OpenAI tunnel authorization cleanup failed: ${error.message}`);
          });
          if (this.localPort !== null) this.scheduleRecovery(null, null);
        }
      }
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.healthUrl = null;
      this.activeTunnelId = null;
      this.activeApiKeyDigest = null;
      this.activeAuthorizationDigest = null;
      this.activeAuthorizationExpiresAt = null;
      if (this.authorizationTimer) clearTimeout(this.authorizationTimer);
      this.authorizationTimer = null;
      this.clearProcessState(child.pid);
      if (!this.stopping) {
        void Promise.resolve(this.options.onAuthorizationInvalidated?.()).catch((error: Error) => {
          this.logger.warn(`OpenAI tunnel authorization cleanup failed: ${error.message}`);
        });
        if (this.localPort !== null) this.scheduleRecovery(code, signal);
      }
    });
  }

  private scheduleRecovery(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.recoveryTimer || this.recoveryAttempts >= this.recoveryLimit) {
      this.logger.error(`OpenAI tunnel-client stopped (${code ?? signal ?? "unknown"}); recovery limit reached.`);
      return;
    }
    this.recoveryAttempts++;
    const attempt = this.recoveryAttempts;
    this.logger.warn(`OpenAI tunnel-client stopped (${code ?? signal ?? "unknown"}); recovery attempt ${attempt}.`);
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      if (this.stopping || this.localPort === null) return;
      const port = this.localPort;
      void this.start(port).catch((error: Error) => {
        this.lastError = error.message;
        this.logger.warn(`OpenAI tunnel-client recovery failed: ${error.message}`);
        if (!this.stopping && port !== null) {
          this.localPort = port;
          this.scheduleRecovery(null, null);
        }
      });
    }, Math.min(1_000 * attempt, 5_000));
  }

  private async startInternal(localPort: number, suppliedAuthorization?: TunnelAuthorization | null): Promise<string | null> {
    if (this.child && this.activeTunnelId) return this.connectorUrl(this.activeTunnelId);
    if (this.stopping) throw new Error("OpenAI tunnel is stopping.");
    const { tunnelId, apiKey } = this.credentials();
    const authorization = suppliedAuthorization === undefined ? await this.authorization() : suppliedAuthorization;
    const binary = this.binary();
    if (!binary) throw new Error("NEED_OPENAI_TUNNEL_CLIENT: official tunnel-client was not found on PATH.");
    if (!this.ownerLock) this.ownerLock = await acquireStateLockAsync(this.lockPath, { timeoutMs: 250 });
    let processStateHandled = !fs.existsSync(this.processStateFile);

    this.localPort = localPort;
    this.lastError = null;
    const healthUrlFile = path.join(this.healthDir, `health-${process.pid}-${Date.now()}.url`);
    try {
      await this.reapSavedProcess();
      processStateHandled = true;
      fs.rmSync(healthUrlFile, { force: true });
      const childEnv = { ...process.env };
      // C2C starts an existing tunnel only; never hand an organization admin
      // credential to the runtime child or make it part of the contract.
      delete childEnv.OPENAI_ADMIN_KEY;
      delete childEnv.OPENAI_API_KEY;
      childEnv.CONTROL_PLANE_TUNNEL_ID = tunnelId;
      childEnv.CONTROL_PLANE_API_KEY = apiKey;
      delete childEnv.C2C_MCP_AUTHORIZATION;
      if (authorization) childEnv.C2C_MCP_AUTHORIZATION = authorization.value;
      if (this.options.controlPlaneBaseUrl) childEnv.CONTROL_PLANE_BASE_URL = this.options.controlPlaneBaseUrl;
      const child = (this.options.spawnProcess ?? spawn)(binary, this.args(localPort, healthUrlFile, tunnelId, authorization !== null), {
        env: childEnv,
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      });
      this.attachChild(child);
      this.saveProcessState(child, tunnelId);
      this.healthUrl = await this.waitForReady(child, healthUrlFile);
      if (this.child !== child || this.stopping) throw new Error("tunnel-client exited during startup");
      this.activeTunnelId = tunnelId;
      this.activeApiKeyDigest = this.apiKeyDigest(apiKey);
      this.activeAuthorizationDigest = authorization ? this.apiKeyDigest(authorization.value) : null;
      this.activeAuthorizationExpiresAt = authorization?.expiresAt ?? null;
      this.authorizationError = null;
      if (authorization) this.scheduleAuthorizationRefresh(authorization.expiresAt);
      this.recoveryAttempts = 0;
      return this.connectorUrl(tunnelId);
    } catch (error) {
      if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
      this.stopping = true;
      try {
        await this.stopChild();
      } catch (stopError) {
        this.stopping = false;
        this.lastError = (stopError as Error).message;
        throw new Error(`${(error as Error).message}; ${this.lastError}; tunnel ownership was retained`);
      }
      this.stopping = false;
      this.localPort = null;
      this.healthUrl = null;
      this.activeTunnelId = null;
      this.activeApiKeyDigest = null;
      this.activeAuthorizationDigest = null;
      this.activeAuthorizationExpiresAt = null;
      if (this.authorizationTimer) clearTimeout(this.authorizationTimer);
      this.authorizationTimer = null;
      // Preserve an unverifiable orphan record. Clearing it would let a later
      // start overlap a PID we explicitly refused to terminate.
      if (processStateHandled) this.clearProcessState();
      this.ownerLock?.release();
      this.ownerLock = null;
      throw error;
    } finally {
      try {
        fs.rmSync(healthUrlFile, { force: true });
      } catch {
        // best effort cleanup of private temporary authorization/health state
      }
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(operation);
    this.lifecycle = next.then(() => undefined, () => undefined);
    return next;
  }

  async start(localPort: number): Promise<string | null> {
    return this.enqueue(async () => {
      let credentials: { tunnelId: string; apiKey: string };
      try {
        credentials = this.credentials();
      } catch (error) {
        // An already-running child owns the last valid credential. Do not
        // tear it down merely because the launching shell no longer exports it.
        if (this.child && this.activeTunnelId) {
          if (this.activeAuthorizationExpiresAt) this.scheduleAuthorizationRefresh(this.activeAuthorizationExpiresAt);
          return this.connectorUrl(this.activeTunnelId);
        }
        throw error;
      }
      let authorization: TunnelAuthorization | null;
      try {
        authorization = await this.authorization();
      } catch (error) {
        if (this.child && this.activeTunnelId) {
          const message = (error as Error).message;
          this.authorizationError = message;
          this.lastError = message;
          if (this.activeAuthorizationExpiresAt && this.activeAuthorizationExpiresAt > Date.now()) {
            this.scheduleAuthorizationRetry(this.activeAuthorizationExpiresAt);
          } else {
            void this.expireAuthorization();
          }
          return this.connectorUrl(this.activeTunnelId);
        }
        throw error;
      }
      const authorizationDigest = authorization ? this.apiKeyDigest(authorization.value) : null;
      if (
        this.child &&
        this.activeTunnelId === credentials.tunnelId &&
        this.activeApiKeyDigest === this.apiKeyDigest(credentials.apiKey) &&
        this.activeAuthorizationDigest === authorizationDigest
      ) {
        if (authorization) {
          this.authorizationError = null;
          this.scheduleAuthorizationRefresh(this.activeAuthorizationExpiresAt ?? authorization.expiresAt);
        }
        return this.connectorUrl(this.activeTunnelId);
      }
      const hadChild = this.child !== null;
      const replacingAuthorization =
        hadChild &&
        this.activeAuthorizationDigest !== null &&
        authorizationDigest !== null &&
        this.activeAuthorizationDigest !== authorizationDigest;
      let oldStopped = false;
      let authorizationInvalidated = false;
      try {
        if (hadChild) {
          // Keep the installation tunnel lock across replacement so another
          // daemon cannot enter the stop/start gap and create an overlap.
          await this.stopCurrent(false);
          oldStopped = true;
        }
        this.stopping = false;
        const url = await this.startInternal(localPort, authorization);
        if (replacingAuthorization) {
          try {
            await this.options.onAuthorizationReplaced?.();
          } catch (error) {
            this.authorizationError = `OpenAI tunnel authorization replacement commit failed: ${(error as Error).message}`;
            this.lastError = this.authorizationError;
            await this.stopCurrent();
            await this.options.onAuthorizationInvalidated?.();
            authorizationInvalidated = true;
            throw error;
          }
        }
        return url;
      } catch (error) {
        if (!this.child && authorization && !authorizationInvalidated && (oldStopped || !hadChild)) {
          try {
            await this.options.onAuthorizationInvalidated?.();
          } catch (invalidateError) {
            this.logger.warn(`OpenAI tunnel authorization cleanup failed: ${(invalidateError as Error).message}`);
          }
        }
        this.releaseIdleOwner();
        throw error;
      }
    });
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let termTimer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (termTimer) clearTimeout(termTimer);
        if (killTimer) clearTimeout(killTimer);
        resolve();
      };
      const fail = (): void => {
        if (settled) return;
        settled = true;
        if (termTimer) clearTimeout(termTimer);
        if (killTimer) clearTimeout(killTimer);
        reject(new Error("OpenAI tunnel-client did not exit after SIGKILL; keeping ownership lock."));
      };
      child.once("exit", finish);
      if (child.exitCode !== null) {
        finish();
        return;
      }
      try {
        child.kill("SIGTERM");
      } catch {
        finish();
        return;
      }
      termTimer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone; wait for the exit event
        }
        killTimer = setTimeout(fail, 2_000);
      }, 2_000);
    });
    if (this.child === child) this.child = null;
  }

  private async stopCurrent(releaseOwner = true): Promise<void> {
    this.stopping = true;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    let adoptedOwner = false;
    try {
      // A daemon can die after the child is spawned but before this provider
      // instance is reconstructed. Adopt the verified owner lock and reap the
      // recorded child instead of deleting its state and creating an overlap.
      if (!this.child && fs.existsSync(this.processStateFile)) {
        if (!this.ownerLock) {
          this.ownerLock = await acquireStateLockAsync(this.lockPath, { timeoutMs: 250 });
          adoptedOwner = true;
        }
        await this.reapSavedProcess();
      }
      await this.stopChild();
      this.clearProcessState();
      this.child = null;
      this.healthUrl = null;
      this.localPort = null;
      this.activeTunnelId = null;
      this.activeApiKeyDigest = null;
      this.activeAuthorizationDigest = null;
      this.activeAuthorizationExpiresAt = null;
      if (this.authorizationTimer) clearTimeout(this.authorizationTimer);
      this.authorizationTimer = null;
      if (releaseOwner) {
        this.ownerLock?.release();
        this.ownerLock = null;
      }
      this.stopping = false;
    } catch (error) {
      if (adoptedOwner && !this.child) {
        this.ownerLock?.release();
        this.ownerLock = null;
      }
      // Keep child/owner state intact: a replacement must not race a live client.
      this.stopping = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    // Mark recovery canceled immediately, but let an already queued start finish;
    // the stop operation is serialized behind it and then owns shutdown.
    this.stopRequested = true;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    return this.enqueue(async () => {
      try {
        await this.stopCurrent();
      } finally {
        this.stopRequested = false;
      }
    });
  }

  async restart(localPort: number): Promise<string | null> {
    return this.enqueue(async () => {
      const previousAuthorization = this.activeAuthorizationDigest;
      const authorization = await this.authorization();
      const replacingAuthorization =
        previousAuthorization !== null &&
        authorization !== null &&
        previousAuthorization !== this.apiKeyDigest(authorization.value);
      try {
        await this.stopCurrent(false);
        if (this.stopRequested) throw new Error("OpenAI tunnel restart was canceled by stop.");
      } catch (error) {
        this.releaseIdleOwner();
        throw error;
      }
      try {
        const url = await this.startInternal(localPort, authorization);
        if (replacingAuthorization) await this.options.onAuthorizationReplaced?.();
        return url;
      } catch (error) {
        if (replacingAuthorization) {
          this.authorizationError = `OpenAI tunnel authorization replacement failed: ${(error as Error).message}`;
          this.lastError = this.authorizationError;
        }
        if (replacingAuthorization && this.child) {
          try {
            await this.stopCurrent();
          } catch (stopError) {
            this.logger.warn(`OpenAI tunnel authorization cleanup failed: ${(stopError as Error).message}`);
          }
        }
        if (!this.child && authorization) {
          try {
            await this.options.onAuthorizationInvalidated?.();
          } catch (invalidateError) {
            this.logger.warn(`OpenAI tunnel authorization cleanup failed: ${(invalidateError as Error).message}`);
          }
        }
        this.releaseIdleOwner();
        throw error;
      }
    });
  }

  status(): TunnelStatus {
    const authorizationHealthy = this.isAuthorizationHealthy();
    return {
      running: this.child !== null && this.healthUrl !== null,
      url: this.activeTunnelId ? this.connectorUrl(this.activeTunnelId) : null,
      provider: this.name,
      detail: this.authorizationError
        ? `OPENAI_MCP_AUTHORIZATION_UNHEALTHY: ${this.authorizationError}`
        : this.healthUrl
          ? `health=${this.healthUrl}`
          : !this.child && fs.existsSync(this.processStateFile)
            ? "OPENAI_TUNNEL_CONFLICT: previous tunnel-client state remains"
            : this.child
              ? "tunnel-client running but not ready"
              : this.lastError ?? undefined,
      authorizationHealthy,
      authorizationExpiresAt: this.activeAuthorizationExpiresAt ?? undefined,
    };
  }

  getPublicUrl(): string | null {
    return this.activeTunnelId ? this.connectorUrl(this.activeTunnelId) : null;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    const binaryPath = this.binary();
    const problems: string[] = [];
    let credentials: { tunnelId: string; apiKey: string } | null = null;
    try {
      credentials = this.credentials();
    } catch (error) {
      problems.push((error as Error).message.split(":")[0]);
    }
    if (!binaryPath) problems.push("NEED_OPENAI_TUNNEL_CLIENT: official tunnel-client binary not found");
    if (!credentials) {
      const tunnelId = (this.options.tunnelId?.trim() || process.env.CONTROL_PLANE_TUNNEL_ID?.trim() || "").trim();
      const apiKey = (this.options.apiKey?.trim() || process.env.CONTROL_PLANE_API_KEY?.trim() || "").trim();
      if (!tunnelId || !TUNNEL_ID_RE.test(tunnelId)) {
        problems.push("NEED_OPENAI_TUNNEL_ID: CONTROL_PLANE_TUNNEL_ID is missing or invalid");
      }
      if (!apiKey) problems.push("NEED_OPENAI_TUNNEL_KEY: CONTROL_PLANE_API_KEY is missing");
    }
    const owner = inspectStateLock(this.lockPath);
    if (!this.child && owner.state === "held") problems.push("OPENAI_TUNNEL_CONFLICT: tunnel owner lock is held");
    if (!this.child && owner.state === "unknown") problems.push(`OPENAI_TUNNEL_CONFLICT: ${owner.reason}`);
    if (credentials && this.child === null && owner.state === "free") problems.push("tunnel-client process not running");
    if (this.child && !this.healthUrl) problems.push("tunnel-client running but not ready");
    if (this.child && !this.isAuthorizationHealthy()) {
      problems.push(`OPENAI_MCP_AUTHORIZATION_UNHEALTHY: ${this.authorizationError ?? "current bearer is not usable"}`);
    }
    if (!this.child && fs.existsSync(this.processStateFile)) {
      problems.push("OPENAI_TUNNEL_CONFLICT: previous tunnel-client state remains");
    }
    return {
      provider: this.name,
      binaryFound: binaryPath !== null,
      binaryPath,
      running: this.child !== null && this.healthUrl !== null,
      url: this.getPublicUrl(),
      problems,
    };
  }
}

export { TUNNEL_ID_RE };
export { OpenAiSecureTunnel as OpenAISecureTunnel };
