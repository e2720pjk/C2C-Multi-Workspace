import express, { type Request, type Response, type NextFunction } from "express";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Workspace } from "../workspace/manager.js";
import {
  INSTALLATION_WORKSPACE_ID,
  WorkspaceRegistry,
  type WorkspaceRegistryOptions,
} from "../workspace/registry.js";
import { AuthStore } from "../auth/store.js";
import { createOAuthRouter } from "../auth/oauth.js";
import { bearerAuth } from "../auth/middleware.js";
import { PairingManager } from "../pairing/manager.js";
import { createMcpServer } from "../mcp/server.js";
import { createMcpHttpHandler } from "../mcp/http.js";
import { CloudflaredQuickTunnel } from "../tunnel/cloudflared.js";
import { CloudflaredNamedTunnel } from "../tunnel/cloudflared-named.js";
import type { TunnelProvider } from "../tunnel/provider.js";
import { namedTunnelBinding, readInstallationTunnelState } from "../tunnel/state.js";
import { Logger, nullLogger } from "../logger/index.js";
import { DEFAULT_HOST, DEFAULT_PORT, getStateDir } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import { writeRuntimeState, clearRuntimeState, type RuntimeState } from "./runtime.js";

function tunnelForInstallation(defaultWorkspaceId: string, logger: Logger): TunnelProvider {
  const binding = namedTunnelBinding(readInstallationTunnelState(defaultWorkspaceId));
  if (binding) {
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
  const workspace = registry.resolve();
  const authStore = new AuthStore(legacySingle ? workspace.id : INSTALLATION_WORKSPACE_ID, {
    file:
      opts.authStoreFile ??
      path.join(getStateDir(), "auth", `${legacySingle ? workspace.id : "installation"}.json`),
  });
  const pairing = new PairingManager(INSTALLATION_WORKSPACE_ID, { ttlMs: opts.pairingTtlMs });
  // One provider belongs to the bridge/installation, never to a tool call.
  const tunnel = opts.tunnelProvider ?? tunnelForInstallation(workspace.id, logger);
  const adminToken = `c2c_admin_${randomBytes(24).toString("base64url")}`;

  let publicBaseUrl: string | null = null;
  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  const getBaseUrl = (req: Request): string => {
    if (publicBaseUrl) return publicBaseUrl;
    const proto = req.protocol;
    const hostHeader = req.get("host") ?? `${host}:${port}`;
    return `${proto}://${hostHeader}`;
  };

  const registrySnapshot = (): { workspaceId: string; workspaceIds: string[]; defaultWorkspaceId: string | null } => {
    const current = registry.list();
    return {
      workspaceId: registry.defaultWorkspaceId() ?? workspace.id,
      workspaceIds: current.map((item) => item.workspaceId),
      defaultWorkspaceId: registry.defaultWorkspaceId(),
    };
  };

  // ---- Health (public but minimal) ---------------------------------------

  app.get("/health", (_req, res) => {
    res.json({ service: SERVICE_NAME, version: VERSION, ...registrySnapshot(), status: "ok" });
  });

  // ---- OAuth + discovery -------------------------------------------------

  app.use(
    createOAuthRouter({
      store: authStore,
      pairing,
      workspaceName: legacySingle ? workspace.name : "C2C installation",
      getBaseUrl,
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
    res.json({
      service: SERVICE_NAME,
      version: VERSION,
      ...registrySnapshot(),
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
    res.json({ workspaces: registry.summaries() });
  });

  app.post("/admin/tunnel/start", adminGuard, (_req, res) => {
    tunnel
      .start(port)
      .then((url) => {
        publicBaseUrl = url;
        persistRuntime();
        res.json({ url });
      })
      .catch((error: Error) => {
        logger.error(`Tunnel start failed: ${error.message}`);
        res.status(500).json({ error: "tunnel_failed", message: error.message });
      });
  });

  app.post("/admin/tunnel/stop", adminGuard, (_req, res) => {
    void tunnel.stop().then(() => {
      publicBaseUrl = null;
      persistRuntime();
      res.json({ stopped: true });
    });
  });

  app.post("/admin/revoke-all", adminGuard, (_req, res) => {
    const count = authStore.revokeAll();
    pairing.invalidateAll();
    logger.info(`Revoked all tokens (${count})`);
    res.json({ revoked: count });
  });

  app.post("/admin/shutdown", adminGuard, (_req, res) => {
    res.json({ shuttingDown: true });
    setTimeout(() => {
      void shutdown().then(() => process.exit(0));
    }, 100);
  });

  const { server, port } = await listen(app, host, opts.port ?? DEFAULT_PORT);
  const startedAt = new Date().toISOString();
  logger.info(`Bridge listening on ${host}:${port} for ${registry.list().length} registered workspace(s)`);

  const persistRuntime = (): void => {
    if (opts.persistRuntime === false) return;
    const current = registry.list();
    const defaultId = registry.defaultWorkspaceId() ?? workspace.id;
    const defaultRecord = current.find((item) => item.workspaceId === defaultId) ?? current[0];
    const state: RuntimeState = {
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: defaultId,
      workspaceRoot: defaultRecord?.root ?? workspace.root,
      workspaceIds: legacySingle ? undefined : current.map((item) => item.workspaceId),
      defaultWorkspaceId: legacySingle ? undefined : registry.defaultWorkspaceId(),
      installationId: legacySingle ? undefined : INSTALLATION_WORKSPACE_ID,
      pid: process.pid,
      port,
      adminToken,
      publicUrl: publicBaseUrl,
      startedAt,
    };
    writeRuntimeState(state);
  };
  persistRuntime();

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await tunnel.stop().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (opts.persistRuntime !== false) clearRuntimeState(workspace.id);
    logger.info("Bridge stopped");
  };

  return {
    workspace,
    registry,
    port,
    host,
    adminToken,
    authStore,
    pairing,
    tunnel,
    getPublicBaseUrl: () => publicBaseUrl,
    localBaseUrl: () => `http://${host}:${port}`,
    close: shutdown,
  };
}
