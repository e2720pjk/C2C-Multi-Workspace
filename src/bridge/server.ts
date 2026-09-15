import express, { type Request, type Response, type NextFunction } from "express";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { acquireStateLockAsync, type StateLock } from "../config/lock.js";
import { ensureInstallationIdentity, rememberInstallationPort } from "../config/installation.js";
import { Workspace } from "../workspace/manager.js";
import {
  INSTALLATION_WORKSPACE_ID,
  WorkspaceRegistry,
  type WorkspaceRegistryOptions,
} from "../workspace/registry.js";
import { AuthStore, SUPPORTED_SCOPES } from "../auth/store.js";
import { createOAuthRouter } from "../auth/oauth.js";
import { bearerAuth } from "../auth/middleware.js";
import { PairingManager } from "../pairing/manager.js";
import { createMcpServer } from "../mcp/server.js";
import { createMcpHttpHandler } from "../mcp/http.js";
import { CloudflaredQuickTunnel } from "../tunnel/cloudflared.js";
import { CloudflaredNamedTunnel } from "../tunnel/cloudflared-named.js";
import { OpenAiSecureTunnel, type TunnelAuthorization } from "../tunnel/openai-secure.js";
import type { TunnelProvider } from "../tunnel/provider.js";
import {
  namedTunnelBinding,
  readInstallationTunnelState,
  selectTunnelProvider,
} from "../tunnel/state.js";
import { Logger, nullLogger } from "../logger/index.js";
import { DEFAULT_HOST, DEFAULT_PORT, getStateDir } from "../config/paths.js";
import { RUNTIME_BUILD_ID, RUNTIME_CONTRACT_ID, SERVICE_NAME, VERSION } from "../version.js";
import {
  writeRuntimeState,
  clearInstallationRuntime,
  clearRuntimeState,
  type RuntimeState,
} from "./runtime.js";

function tunnelForInstallation(
  _defaultWorkspaceId: string,
  logger: Logger,
  mcpAuthorization?: () => TunnelAuthorization | Promise<TunnelAuthorization>,
  onAuthorizationInvalidated?: () => void,
  usePersistedState = true
): TunnelProvider {
  // Non-persisted embedded bridges are isolated test/consumer instances; they
  // must not inherit the user's installation provider choice.
  const state = usePersistedState
    ? readInstallationTunnelState()
    : { workspaceId: INSTALLATION_WORKSPACE_ID, preference: "unset" as const };
  const selection = selectTunnelProvider(state, usePersistedState ? process.env : {});
  if (selection.provider === "openai-secure") {
    return new OpenAiSecureTunnel({
      logger,
      tunnelId: state.tunnelId || process.env.CONTROL_PLANE_TUNNEL_ID?.trim(),
      mcpAuthorization,
      onAuthorizationInvalidated,
    });
  }
  const binding = namedTunnelBinding(state);
  if (selection.provider === "cloudflare-named") {
    if (!binding) throw new Error("CONFIGURED_PROVIDER_UNAVAILABLE: persisted named tunnel state is incomplete.");
    return new CloudflaredNamedTunnel({
      tunnelName: binding.tunnelName,
      hostname: binding.hostname,
      logger,
    });
  }
  return new CloudflaredQuickTunnel(logger);
}

export interface BridgeOptions {
  /** Existing single-workspace spelling; also seeds the installation registry. */
  workspaceRoot?: string;
  /** Additional registered roots served by this one endpoint. */
  workspaceRoots?: string[];
  /** Reuse a registry, mainly for embedded callers and tests. */
  registry?: WorkspaceRegistry;
  registryFile?: string;
  defaultWorkspace?: string;
  port?: number;
  host?: string;
  logger?: Logger;
  tunnelProvider?: TunnelProvider;
  /** Persist runtime state (disable in tests). */
  persistRuntime?: boolean;
  /** Deterministic build identity seam for lifecycle tests; production uses the computed id. */
  runtimeBuildId?: string;
  /** Test seam: production daemons exit after an authenticated shutdown request. */
  exitOnShutdown?: boolean;
  authStoreFile?: string;
  pairingTtlMs?: number;
  accessTokenTtlMs?: number;
}

export interface Bridge {
  /** Stable default/legacy view. Tool calls resolve their own target. */
  workspace: Workspace;
  registry: WorkspaceRegistry;
  port: number;
  host: string;
  installationId?: string;
  adminToken: string;
  authStore: AuthStore;
  pairing: PairingManager;
  tunnel: TunnelProvider;
  getPublicBaseUrl(): string | null;
  localBaseUrl(): string;
  close(): Promise<void>;
}

/** Listen on the preferred port; on EADDRINUSE fall back to an ephemeral port. */
function listen(app: express.Express, host: string, preferredPort: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, allowFallback: boolean): void => {
      const server = app.listen(port, host);
      server.once("listening", () => {
        const address = server.address();
        const actual = typeof address === "object" && address ? address.port : port;
        resolve({ server, port: actual });
      });
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && allowFallback) {
          tryListen(0, false);
        } else {
          reject(error);
        }
      });
    };
    tryListen(preferredPort, preferredPort !== 0);
  });
}

export async function startBridge(opts: BridgeOptions): Promise<Bridge> {
  const logger = opts.logger ?? nullLogger;
  const runtimeBuildId = opts.runtimeBuildId ?? RUNTIME_BUILD_ID;
  const exitOnShutdown = opts.exitOnShutdown ?? true;
  const host = opts.host ?? DEFAULT_HOST;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The bridge only binds to loopback addresses. Public exposure goes through the tunnel.");
  }

  const roots = [
    ...(opts.workspaceRoot ? [opts.workspaceRoot] : []),
    ...(opts.workspaceRoots ?? []),
  ].filter(Boolean);
  // Direct test/embedded single-workspace callers retain their isolated
  // behavior. Daemons use the persisted installation registry.
  const legacySingle =
    opts.persistRuntime === false &&
    opts.workspaceRoot !== undefined &&
    opts.workspaceRoots === undefined &&
    roots.length === 1 &&
    !opts.registry;
  const registry =
    opts.registry ??
    new WorkspaceRegistry({
      file: opts.registryFile,
      persist: opts.registryFile !== undefined || opts.persistRuntime !== false,
    } satisfies WorkspaceRegistryOptions);
  for (const root of roots) registry.register(root);
  if (opts.defaultWorkspace !== undefined) registry.setDefault(opts.defaultWorkspace);
  const workspace = opts.defaultWorkspace !== undefined ? registry.resolve(opts.defaultWorkspace) : registry.primary();
  const ownsInstallation = opts.persistRuntime !== false;
  const installationId = ownsInstallation ? ensureInstallationIdentity().installationId : undefined;
  const authStore = new AuthStore(legacySingle ? workspace.id : INSTALLATION_WORKSPACE_ID, {
    file:
      opts.authStoreFile ??
      path.join(getStateDir(), "auth", `${legacySingle ? workspace.id : "installation"}.json`),
  });
  const tunnelTokenTtlMs = Math.max(1_000, opts.accessTokenTtlMs ?? 5 * 60 * 1_000);
  let tunnelAuthorization: { raw: string; value: string; expiresAt: number } | null = null;
  const getTunnelAuthorization = (): TunnelAuthorization => {
    const refreshAt = Date.now() + 30_000;
    if (tunnelAuthorization && tunnelAuthorization.expiresAt > refreshAt) {
      return { value: tunnelAuthorization.value, expiresAt: tunnelAuthorization.expiresAt };
    }
    if (tunnelAuthorization) authStore.revokeToken(tunnelAuthorization.raw);
    const issued = authStore.issueTokens({
      clientId: "c2c-openai-tunnel",
      scopes: [...SUPPORTED_SCOPES].filter((scope) => scope !== "offline_access"),
      accessTtlMs: tunnelTokenTtlMs,
    });
    tunnelAuthorization = {
      raw: issued.accessToken,
      value: `Bearer ${issued.accessToken}`,
      expiresAt: Date.now() + tunnelTokenTtlMs,
    };
    return { value: tunnelAuthorization.value, expiresAt: tunnelAuthorization.expiresAt };
  };
  const clearTunnelAuthorization = (): void => {
    if (tunnelAuthorization) authStore.revokeToken(tunnelAuthorization.raw);
    tunnelAuthorization = null;
  };
  const pairing = new PairingManager(INSTALLATION_WORKSPACE_ID, { ttlMs: opts.pairingTtlMs });
  // One provider belongs to the bridge/installation, never to a tool call.
  const tunnel =
    opts.tunnelProvider ?? tunnelForInstallation(workspace.id, logger, getTunnelAuthorization, clearTunnelAuthorization, ownsInstallation);
  const adminToken = `c2c_admin_${randomBytes(24).toString("base64url")}`;

  let publicBaseUrl: string | null = null;
  let closed = false;
  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  const getBaseUrl = (req: Request): string => {
    if (publicBaseUrl) return publicBaseUrl;
    const proto = req.protocol;
    const hostHeader = req.get("host") ?? `${host}:${port}`;
    return `${proto}://${hostHeader}`;
  };
  const pathQualifiedPublicUrl = (): boolean => tunnel.name === "openai-secure" && publicBaseUrl !== null;

  const registrySnapshot = (): { workspaceId: string; workspaceIds: string[]; defaultWorkspaceId: string | null } => {
    const current = registry.list();
    const defaultId = registry.defaultWorkspaceId();
    const fallback = current.find((item) => item.workspaceId === workspace.id) ?? current[0];
    return {
      workspaceId: defaultId ?? fallback?.workspaceId ?? workspace.id,
      workspaceIds: current.map((item) => item.workspaceId),
      defaultWorkspaceId: defaultId,
    };
  };

  // ---- Health (public but minimal) ---------------------------------------

  app.get("/health", (_req, res) => {
    res.json({
      service: SERVICE_NAME,
      version: VERSION,
      contractId: RUNTIME_CONTRACT_ID,
      buildId: runtimeBuildId,
      installationId,
      pid: process.pid,
      port,
      ...registrySnapshot(),
      status: "ok",
    });
  });

  // ---- OAuth + discovery -------------------------------------------------

  app.use(
    createOAuthRouter({
      store: authStore,
      pairing,
      workspaceName: legacySingle ? workspace.name : "C2C installation",
      getBaseUrl,
      getResourceUrl: (_req, base) => (pathQualifiedPublicUrl() ? base : `${base}/mcp`),
      logger,
    })
  );

  // ---- MCP endpoint (bearer-protected) -----------------------------------

  const mcpHandler = createMcpHttpHandler(
    () =>
      createMcpServer({
        workspace: legacySingle ? workspace : undefined,
        registry: legacySingle ? undefined : registry,
        logger,
      }),
    logger
  );
  app.all(
    "/mcp",
    express.json({ limit: "8mb" }),
    bearerAuth({
      store: authStore,
      // Multi-workspace tokens authorize the installation, not one target.
      workspaceId: legacySingle ? workspace.id : undefined,
      getBaseUrl,
      logger,
    }),
    (req: Request, res: Response) => {
      void mcpHandler(req, res);
    }
  );

  // ---- Admin API (loopback + admin token only; used by the CLI/Skill) ----

  const adminGuard = (req: Request, res: Response, next: NextFunction): void => {
    const remote = req.socket.remoteAddress ?? "";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const viaProxy = Boolean(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]);
    const header = req.headers.authorization ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!isLoopback || viaProxy || token !== adminToken) {
      res.status(404).end();
      return;
    }
    next();
  };

  app.post("/admin/pairing", adminGuard, (_req, res) => {
    const session = pairing.create();
    logger.info("Created pairing session");
    res.json({ code: session.code, expiresAt: session.expiresAt });
  });

  app.get("/admin/info", adminGuard, (_req, res) => {
    const snapshot = registrySnapshot();
    persistRuntime();
    res.json({
      service: SERVICE_NAME,
      version: VERSION,
      contractId: RUNTIME_CONTRACT_ID,
      buildId: runtimeBuildId,
      installationId,
      ...snapshot,
      workspaceName: workspace.name,
      workspaceRoot: workspace.root,
      workspaces: registry.summaries(),
      port,
      publicUrl: publicBaseUrl,
      tunnel: tunnel.status(),
      tokenCount: authStore.tokenCount(),
      pairingActive: pairing.hasActiveSession(),
      pid: process.pid,
      startedAt,
    });
  });

  app.get("/admin/workspaces", adminGuard, (_req, res) => {
    persistRuntime();
    res.json({ workspaces: registry.summaries() });
  });

  let tunnelOperation: Promise<unknown> = Promise.resolve();
  const withTunnelOperation = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = tunnelOperation.then(operation);
    tunnelOperation = next.then(() => undefined, () => undefined);
    return next;
  };

  app.post("/admin/tunnel/start", adminGuard, (_req, res) => {
    void withTunnelOperation(async () => {
      if (closed) throw new Error("Bridge is shutting down.");
      const status = tunnel.status();
      const url = status.running ? (status.url ?? tunnel.getPublicUrl()) : await tunnel.start(port);
      publicBaseUrl = url;
      persistRuntime();
      return url;
    })
      .then((url) => res.json({ url }))
      .catch((error: Error) => {
        clearTunnelAuthorization();
        logger.error(`Tunnel start failed: ${error.message}`);
        res.status(500).json({ error: "tunnel_failed", message: error.message });
      });
  });

  app.post("/admin/tunnel/stop", adminGuard, (_req, res) => {
    void withTunnelOperation(async () => {
      // Stop even when a provider child is still starting and therefore is not
      // yet reported as ready; otherwise its credential remains live.
      await tunnel.stop();
      clearTunnelAuthorization();
      publicBaseUrl = null;
      persistRuntime();
    })
      .then(() => res.json({ stopped: true }))
      .catch((error: Error) => res.status(500).json({ error: "tunnel_failed", message: error.message }));
  });

  app.post("/admin/revoke-all", adminGuard, (_req, res) => {
    const count = authStore.revokeAll();
    pairing.invalidateAll();
    clearTunnelAuthorization();
    const tunnelStatus = tunnel.status();
    const tunnelHasChild = tunnelStatus.running || Boolean(tunnelStatus.detail?.includes("running"));
    const operation =
      tunnel.name === "openai-secure" && tunnelHasChild
        ? withTunnelOperation(async () => {
            const url = await tunnel.restart(port);
            publicBaseUrl = url;
            persistRuntime();
          })
        : Promise.resolve();
    void operation
      .then(() => {
        logger.info(`Revoked all tokens (${count})`);
        res.json({ revoked: count });
      })
      .catch((error: Error) => res.status(500).json({ error: "tunnel_failed", message: error.message }));
  });

  app.post("/admin/shutdown", adminGuard, (_req, res) => {
    res.json({ shuttingDown: true });
    setTimeout(() => {
      void shutdown()
        .then(() => {
          if (exitOnShutdown) process.exit(0);
        })
        .catch((error: Error) => logger.error(`Bridge shutdown failed: ${error.message}`));
    }, 100);
  });

  let ownerLock: StateLock | null = null;
  if (ownsInstallation) {
    ownerLock = await acquireStateLockAsync(path.join(getStateDir(), "runtime", "installation-owner.lock"), { timeoutMs: 250 });
    // Only the verified installation owner may revoke a previous internal
    // tunnel authorization; a direct second serve must fail at the lock first.
    try {
      authStore.revokeClientTokens("c2c-openai-tunnel");
    } catch (error) {
      ownerLock.release();
      ownerLock = null;
      throw error;
    }
  }

  let server: Server;
  let port: number;
  try {
    ({ server, port } = await listen(app, host, opts.port ?? DEFAULT_PORT));
  } catch (error) {
    ownerLock?.release();
    throw error;
  }
  const startedAt = new Date().toISOString();
  logger.info(`Bridge listening on ${host}:${port} for ${registry.list().length} registered workspace(s)`);

  const persistRuntime = (): void => {
    if (opts.persistRuntime === false) return;
    const current = registry.list();
    const defaultId = registry.defaultWorkspaceId() ?? current[0]?.workspaceId ?? workspace.id;
    const defaultRecord = current.find((item) => item.workspaceId === defaultId) ?? current[0];
    const state: RuntimeState = {
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: defaultId,
      workspaceRoot: defaultRecord?.root ?? workspace.root,
      workspaceIds: legacySingle ? undefined : current.map((item) => item.workspaceId),
      defaultWorkspaceId: legacySingle ? undefined : registry.defaultWorkspaceId(),
      installationId: legacySingle ? undefined : installationId,
      contractId: legacySingle ? undefined : RUNTIME_CONTRACT_ID,
      buildId: legacySingle ? undefined : runtimeBuildId,
      ownerToken: legacySingle ? undefined : ownerLock?.owner.token,
      processIdentity: legacySingle ? undefined : ownerLock?.owner.processIdentity,
      pid: process.pid,
      port,
      adminToken,
      publicUrl: publicBaseUrl,
      startedAt,
    };
    writeRuntimeState(state);
  };
  try {
    if (ownsInstallation) rememberInstallationPort(port);
    persistRuntime();
  } catch (error) {
    ownerLock?.release();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }

  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // Do not release the installation owner while a tunnel child may still be alive.
    try {
      await withTunnelOperation(() => tunnel.stop());
    } catch (error) {
      // Keep the daemon owner and runtime authoritative while a child may
      // still be alive; releasing them would permit an overlapping tunnel.
      logger.error(`Tunnel stop failed during shutdown: ${(error as Error).message}`);
      closed = false;
      throw error;
    }
    clearTunnelAuthorization();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (ownsInstallation) clearInstallationRuntime();
    else clearRuntimeState(workspace.id);
    ownerLock?.release();
    ownerLock = null;
    logger.info("Bridge stopped");
  };

  return {
    workspace,
    registry,
    port,
    host,
    installationId,
    adminToken,
    authStore,
    pairing,
    tunnel,
    getPublicBaseUrl: () => publicBaseUrl,
    localBaseUrl: () => `http://${host}:${port}`,
    close: shutdown,
  };
}
