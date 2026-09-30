import { Command, InvalidArgumentError, Option } from "commander";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startBridge } from "../bridge/server.js";
import { findInstallationObservation, type RuntimeState } from "../bridge/runtime.js";
import { readInstallationIdentity } from "../config/installation.js";
import { adminFetch, ensureBridge, stopBridge, withInstallationStartupLock } from "../process/daemon.js";
import { Workspace } from "../workspace/manager.js";
import { INSTALLATION_WORKSPACE_ID, WorkspaceRegistry } from "../workspace/registry.js";
import { AuthStore } from "../auth/store.js";
import { detectTunnelBinaries } from "../tunnel/detect.js";
import {
  chooseQuickTunnel,
  hasCloudflaredCert,
  ProcessCloudflaredAccount,
  provisionNamedTunnel,
} from "../tunnel/named-provision.js";
import { parseZoneInput, suggestedNamedHostname } from "../tunnel/hostname.js";
import {
  isNamedTunnelReady,
  connectionMode,
  namedLoginPrompt,
  namedRepairMessage,
  openAiRuntimeConfiguration,
  readInstallationTunnelState,
  selectTunnelProvider,
  writeTunnelState,
  type TunnelState,
} from "../tunnel/state.js";
import { Logger } from "../logger/index.js";
import { getStateDir } from "../config/paths.js";
import { ensureSandboxAllowlist, getCodexConfigPath, isStateDirAllowlisted } from "../config/sandbox-allow.js";
import { mergeUiPrefs, readUiPrefs, SETUP_MODES, type SetupMode } from "../config/ui-prefs.js";
import { LANGUAGES, t, type Language } from "../config/language.js";
import { localizeHelp } from "./help.js";
import {
  CHATGPT_CREATE_CONNECTOR_URL,
  CHATGPT_DEVELOPER_MODE_URL,
  CHATGPT_PLUGINS_URL,
  connectorAction,
  connectorNameFor,
  mcpUrlFromPublic,
  normalizePublicUrl,
  readLastEndpoint,
  reclaimUserMessage,
  writeLastEndpoint,
  type LastEndpoint,
} from "../config/endpoint.js";
import { PRODUCT_NAME, RUNTIME_BUILD_ID, RUNTIME_CONTRACT_ID, VERSION } from "../version.js";
import {
  clearChatPointer,
  mergeSession,
  readSession,
  resolveConversation,
  writeSession,
  PROTOCOL_STATES,
  WAITING_FOR,
  type ConversationMode,
  type ProtocolState,
  type WaitingFor,
} from "../session/state.js";
import { appendExecutionRecord } from "../execution/records.js";
import { saveExecutionOutput } from "../execution/output.js";

const program = new Command();

const say = (msg: string): void => {
  process.stdout.write(msg + "\n");
};
const check = (msg: string): void => say(`✓ ${msg}`);
const cross = (msg: string): void => say(`✗ ${msg}`);

function resolveWorkspace(option?: string): string {
  return path.resolve(option ?? process.cwd());
}

function runtimeCompatibility(requireCurrentBuild = true): {
  expectedInstallationId: string;
  expectedContractId: string;
  expectedBuildId?: string;
} {
  let identity: ReturnType<typeof readInstallationIdentity> = null;
  try {
    identity = readInstallationIdentity();
  } catch {
    // Corrupt identity state must not become a wildcard that can reuse a daemon.
    identity = { version: 1, installationId: "corrupt-installation-identity", createdAt: "" };
  }
  return {
    // A missing or corrupt identity is not proof that an active daemon belongs to this CLI.
    expectedInstallationId: identity?.installationId ?? "missing-installation-identity",
    expectedContractId: RUNTIME_CONTRACT_ID,
    ...(requireCurrentBuild ? { expectedBuildId: RUNTIME_BUILD_ID } : {}),
  };
}

const INSTALLATION_ENDPOINT_ID = INSTALLATION_WORKSPACE_ID;

function tunnelStateConfiguration(state: TunnelState): string {
  return JSON.stringify({
    preference: state.preference,
    provider: state.provider,
    tunnelId: state.tunnelId,
    tunnelName: state.tunnelName,
    hostname: state.hostname,
    zone: state.zone,
  });
}

function validateOpenAiChoice(): string {
  const state = readInstallationTunnelState();
  const config = openAiRuntimeConfiguration(process.env, state.preference === "openai" ? state.tunnelId : undefined);
  if (!config.complete || !config.tunnelId) {
    throw new Error(`INCOMPLETE_OPENAI_CONFIGURATION: missing ${config.missing.join(" and ")}`);
  }
  if (!detectTunnelBinaries().tunnelClient) {
    throw new Error("NEED_OPENAI_TUNNEL_CLIENT: official tunnel-client is not installed or not on PATH.");
  }
  return config.tunnelId;
}

/** Commit a provider choice while holding the same lock used by daemon startup. */
async function commitTunnelChoice(target: TunnelState): Promise<TunnelState> {
  return withInstallationStartupLock(async (startupLock) => {
    const current = readInstallationTunnelState();
    const observation = await findInstallationObservation(undefined, runtimeCompatibility());
    if (observation.state === "unknown") {
      if (observation.reason === "build_mismatch" && observation.runtime) {
        await stopBridge(undefined, startupLock);
      } else {
        throw new Error(`Bridge state is uncertain (${observation.reason}); refusing to change tunnel state.`);
      }
    } else if (observation.state === "healthy") {
      const info = await adminFetch<{ tunnel: { provider: string } }>(observation.runtime, "GET", "/admin/info");
      const currentProvider = selectTunnelProvider(current).provider;
      if (info.tunnel.provider !== currentProvider) {
        throw new Error("Running provider does not match canonical tunnel state; refusing to replace it.");
      }
      if (
        info.tunnel.provider !== target.provider ||
        tunnelStateConfiguration(current) !== tunnelStateConfiguration(target)
      ) {
        await stopBridge(undefined, startupLock);
      }
    }
    return writeTunnelState(target);
  });
}

function previousInstallationEndpoint(_workspaceId: string): LastEndpoint | null {
  return readLastEndpoint(INSTALLATION_ENDPOINT_ID);
}

function parseInteger(value: string): number {
  const normalized = value.trim();
  if (!/^-?\d+$/.test(normalized)) {
    throw new InvalidArgumentError("must be an integer");
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) throw new InvalidArgumentError("must be a safe integer");
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = parseInteger(value);
  if (parsed < 0) throw new InvalidArgumentError("must be a non-negative integer");
  return parsed;
}

function parseChangedFiles(value: string): string[] | number {
  const normalized = value.trim();
  if (/^-?\d+$/.test(normalized)) {
    const count = parseInteger(normalized);
    if (count < 0) {
      throw new InvalidArgumentError("changed-files count must be a non-negative safe integer");
    }
    return count;
  }
  return value.split(",").map((file) => file.trim()).filter(Boolean);
}

/** Local harness output only. Never pasted into ChatGPT. */
const MAX_RECORD_OUTPUT_READ = 256 * 1024;

function readCappedUtf8(filePath: string, maxBytes: number): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function mcpUrlForTunnel(info: Pick<AdminInfo, "publicUrl" | "tunnel">): string | null {
  if (!info.publicUrl || (info.tunnel.provider === "openai-secure" && info.tunnel.authorizationHealthy === false)) return null;
  return info.tunnel.provider === "openai-secure" ? info.publicUrl : `${info.publicUrl}/mcp`;
}

function persistWorkspaceEndpoint(opts: {
  workspaceId: string;
  workspaceName: string;
  port: number;
  publicUrl: string | null;
  mcpUrl: string;
  previous?: LastEndpoint | null;
}): string {
  const previous = opts.previous ?? readLastEndpoint(opts.workspaceId);
  const connectorName = connectorNameFor({
    workspaceName: opts.workspaceName,
    workspaceId: opts.workspaceId,
    previousName: previous?.connectorName,
    hadEndpointBefore: Boolean(previous),
  });
  writeLastEndpoint({
    workspaceId: opts.workspaceId,
    port: opts.port,
    publicUrl: opts.publicUrl,
    mcpUrl: opts.mcpUrl,
    connectorName,
  });
  return connectorName;
}

function connectionPayload(zoneHint?: string) {
  const state = readInstallationTunnelState();
  const binaries = detectTunnelBinaries();
  const selection = selectTunnelProvider(state);
  const mode = connectionMode(state);
  const openaiConfig = openAiRuntimeConfiguration(process.env, state.preference === "openai" ? state.tunnelId : undefined);
  const diagnostic = selection.diagnostic ??
    (mode === "secure" && !binaries.tunnelClient ? "NEED_OPENAI_TUNNEL_CLIENT" :
      mode === "pairing" && !binaries.cloudflared ? "NEED_CLOUDFLARED" : undefined);
  const zone = parseZoneInput(zoneHint ?? "") ?? state.zone ?? null;
  return {
    ok: true,
    connectionMode: mode,
    connectorAuthentication: mode === "secure" ? "none" : "oauth-pairing",
    configured: diagnostic === undefined,
    diagnostic,
    needsChoice: false,
    preference: mode === "secure" ? "openai" : state.preference,
    selectedModeLabel: mode === "secure" ? "OpenAI Secure Tunnel" : "Pairing (Cloudflare + OAuth)",
    provider: selection.provider,
    loggedIn: hasCloudflaredCert(),
    openaiConfigured: openaiConfig.complete,
    openaiDiagnostic: selection.diagnostic,
    tunnelClientFound: binaries.tunnelClient !== null,
    namedReady: isNamedTunnelReady(state),
    zone,
    hostname: state.hostname ?? null,
    suggestedHostname: zone ? suggestedNamedHostname(zone, PRODUCT_NAME, INSTALLATION_ENDPOINT_ID) : null,
    loginPrompt: mode === "pairing" ? namedLoginPrompt() : undefined,
    fallbackReason: state.fallbackReason,
  };
}

function requirePairingMode(): void {
  if (connectionMode(readInstallationTunnelState()) !== "pairing") {
    throw new Error(t(
      "PAIRING_DISABLED: Secure Tunnel does not use pairing codes. Switch explicitly with c2c connection use pairing.",
      "PAIRING_DISABLED: Secure Tunnel 不使用配對碼。請明確執行 c2c connection use pairing 切換。"
    ));
  }
}

async function tunnelLiveState(): Promise<{ bridgeRunning: boolean; tunnelRunning: boolean; liveProvider: string | null }> {
  const observation = await findInstallationObservation(undefined, runtimeCompatibility(false));
  if (observation.state === "unknown") throw new Error(`BRIDGE_STATE_UNKNOWN: ${observation.reason}`);
  if (observation.state === "stopped") return { bridgeRunning: false, tunnelRunning: false, liveProvider: null };
  const info = await adminFetch<AdminInfo>(observation.runtime, "GET", "/admin/info");
  return { bridgeRunning: true, tunnelRunning: info.tunnel.running, liveProvider: info.tunnel.provider };
}

function trySandboxAllow():
  | { ok: true; added: boolean; alreadyAllowed: boolean; stateDir: string; configPath: string }
  | { ok: false; added: false; alreadyAllowed: false; error: string } {
  try {
    const result = ensureSandboxAllowlist();
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, added: false, alreadyAllowed: false, error: (error as Error).message };
  }
}

interface TunnelStartResponse {
  url?: string | null;
  error?: string;
  message?: string;
}

interface PairingResponse {
  code: string;
  expiresAt: number;
}

interface AdminInfo {
  service?: string;
  version?: string;
  contractId?: string;
  buildId?: string;
  installationId?: string;
  workspaceId: string;
  workspaceIds?: string[];
  defaultWorkspaceId?: string | null;
  workspaceName: string;
  workspaceRoot: string;
  workspaces?: Array<Record<string, unknown>>;
  port: number;
  publicUrl: string | null;
  tunnel: {
    running: boolean;
    url: string | null;
    provider: string;
    detail?: string;
    authorizationHealthy?: boolean;
  };
  tokenCount: number;
  pairingActive: boolean;
  pid: number;
  startedAt: string;
}

function validateConnection(): void {
  const selection = selectTunnelProvider(readInstallationTunnelState());
  if (selection.diagnostic) throw new Error(selection.diagnostic);
  const binaries = detectTunnelBinaries();
  if (selection.provider === "openai-secure" && !binaries.tunnelClient) {
    throw new Error("NEED_OPENAI_TUNNEL_CLIENT: official tunnel-client is not installed or not on PATH.");
  }
  if (selection.provider.startsWith("cloudflare") && !binaries.cloudflared) {
    throw new Error("NEED_CLOUDFLARED: cloudflared is not installed. Install it first (macOS: brew install cloudflared).");
  }
}

async function ensureBridgeAndTunnel(
  workspaceRoot: string,
  opts: { tunnel: boolean }
): Promise<{ runtime: RuntimeState; info: AdminInfo; mcpUrl: string | null; workspace: Workspace }> {
  const targetWorkspace = new Workspace(workspaceRoot);
  if (opts.tunnel) validateConnection();
  const { runtime } = await ensureBridge(targetWorkspace.root);
  let info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
  if (opts.tunnel) {
    const selected = selectTunnelProvider(readInstallationTunnelState()).provider;
    if (info.tunnel.provider !== selected) {
      throw new Error("CONNECTION_PROFILE_MISMATCH: the running bridge uses a different profile. Run c2c restart.");
    }
    if (info.buildId !== RUNTIME_BUILD_ID) {
      throw new Error("BRIDGE_UPDATE_REQUIRED: run c2c restart before establishing a public connection with this build.");
    }
  }
  let mcpUrl: string | null = mcpUrlForTunnel(info);
  if (opts.tunnel && (!info.tunnel.running || info.tunnel.authorizationHealthy === false)) {
    await adminFetch<TunnelStartResponse>(runtime, "POST", "/admin/tunnel/start", 90_000);
    info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
    mcpUrl = mcpUrlForTunnel(info);
  }
  if (
    opts.tunnel &&
    info.tunnel.provider === "openai-secure" &&
    (!info.tunnel.running || info.tunnel.authorizationHealthy === false)
  ) {
    throw new Error(info.tunnel.detail ?? "OPENAI_MCP_AUTHORIZATION_UNHEALTHY: tunnel authorization is not usable.");
  }
  return { runtime, info, mcpUrl, workspace: targetWorkspace };
}

program
  .name("c2c")
  .description(t(`${PRODUCT_NAME} — ChatGPT thinks. Codex works.`, `${PRODUCT_NAME} — ChatGPT 規劃，Codex 執行。`))
  .version(VERSION, "-v, --version")
  .configureHelp({ sortSubcommands: true })
  .addHelpText(
    "after",
    t(`
Connection profiles:
  Secure Tunnel (default): existing OpenAI Tunnel ID + runtime API key + tunnel-client.
    c2c setup                          ChatGPT: Tunnel / No authentication
  Pairing (explicit opt-in): Cloudflare Quick/Named Tunnel + OAuth.
    c2c connection use pairing         ChatGPT: HTTPS URL / OAuth
    c2c pair                           Run only when the authorization form is open.
  c2c workspace add [path]             Defaults to the current directory.
  c2c prefs set --language en          Supported languages: en, zh-TW.
`, `
連線設定檔：
  Secure Tunnel（預設）：既有 OpenAI Tunnel ID、執行階段 API Key 與 tunnel-client。
    c2c setup                          ChatGPT：Tunnel / No authentication
  Pairing（需明確切換）：Cloudflare Quick/Named Tunnel 與 OAuth。
    c2c connection use pairing         ChatGPT：HTTPS 位址 / OAuth
    c2c pair                           僅在授權表單開啟後執行。
  c2c workspace add [path]             預設為目前目錄。
  c2c prefs set --language zh-TW       支援 en、zh-TW。
`)
  );

/** Machine-wide commands ignore `-w` so a Skill that always passes it cannot crash them. */
function acceptUnusedWorkspaceOption(command: Command): Command {
  return command.addOption(new Option("-w, --workspace <path>", "deprecated and ignored; installation-wide command").hideHelp());
}

// ---------------------------------------------------------------- serve (internal)

program
  .command("serve", { hidden: true })
  .description("Run the bridge in the foreground (internal)")
  .requiredOption("--workspace <path>")
  .option("--port <port>", "preferred port")
  .action(async (opts: { workspace: string; port?: string }) => {
    const logger = new Logger({ name: "bridge", console: true });
    const bridge = await startBridge({
      workspaceRoot: resolveWorkspace(opts.workspace),
      port: opts.port ? parseInt(opts.port, 10) : undefined,
      logger,
    });
    const shutdown = (): void => {
      void bridge.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    say(`bridge ready on ${bridge.localBaseUrl()} (workspace ${bridge.workspace.name})`);
  });

// ---------------------------------------------------------------- start

program
  .command("start")
  .description("Start (or reuse) the installation bridge and register this workspace")
  .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
  .option("--no-tunnel", "local-only bridge (development)")
  .addOption(new Option("--tunnel", "establish the selected connection (default)").hideHelp())
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; tunnel: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const { runtime, info, mcpUrl, workspace: targetWorkspace } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      const connectorName = mcpUrl
        ? persistWorkspaceEndpoint({
            workspaceId: INSTALLATION_ENDPOINT_ID,
            workspaceName: PRODUCT_NAME,
            port: runtime.port,
            publicUrl: info.publicUrl,
            mcpUrl,
            previous: previousInstallationEndpoint(info.workspaceId),
          })
        : previousInstallationEndpoint(info.workspaceId)?.connectorName;
      if (opts.json) {
        say(JSON.stringify({ ok: true, port: runtime.port, workspaceId: targetWorkspace.id, workspaceName: targetWorkspace.name, mcpUrl, connectorName, tunnelProvider: info.tunnel.provider, connectionMode: info.tunnel.provider === "openai-secure" ? "secure" : "pairing" }));
        return;
      }
      check(t(`Workspace recognized (${targetWorkspace.name})`, `已識別工作區（${targetWorkspace.name}）`));
      check(t("Installation bridge started", "安裝級 Bridge 已啟動"));
      if (mcpUrl) check(t(`Connection: ${mcpUrl}`, `連線：${mcpUrl}`));
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- setup

program
  .command("setup")
  .description("Prepare this workspace and the selected connection (Secure Tunnel by default)")
  .option("-w, --workspace <path>")
  .option("--no-tunnel", "local-only setup (development)")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; tunnel: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      if (!opts.json) {
        say(PRODUCT_NAME);
        say("");
        say(t("Preparing the ChatGPT connection...", "正在準備 ChatGPT 連線…"));
        say("");
      }
      const sandbox = trySandboxAllow();
      const { runtime, info, mcpUrl, workspace: targetWorkspace } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      const connectorName = mcpUrl
        ? persistWorkspaceEndpoint({
            workspaceId: INSTALLATION_ENDPOINT_ID,
            workspaceName: PRODUCT_NAME,
            port: runtime.port,
            publicUrl: info.publicUrl,
            mcpUrl,
            previous: previousInstallationEndpoint(info.workspaceId),
          })
        : connectorNameFor({
            workspaceName: PRODUCT_NAME,
            workspaceId: INSTALLATION_ENDPOINT_ID,
            previousName: previousInstallationEndpoint(info.workspaceId)?.connectorName,
            hadEndpointBefore: Boolean(previousInstallationEndpoint(info.workspaceId)),
          });
      const openAiTunnel = info.tunnel.provider === "openai-secure";
      const tunnelState = readInstallationTunnelState();
      if (opts.json) {
        say(
          JSON.stringify({
            ok: true,
            workspaceId: targetWorkspace.id,
            workspaceName: targetWorkspace.name,
            connectorName,
            mcpUrl,
            local: mcpUrl === null,
            connectionMode: openAiTunnel ? "secure" : "pairing",
            connectorAuthentication: openAiTunnel ? "none" : "oauth-pairing",
            pairingRequired: !openAiTunnel,
            sandbox,
            tunnel: {
              provider: info.tunnel.provider,
              mode: info.tunnel.provider === "openai-secure" ? "openai" : isNamedTunnelReady(tunnelState) ? "named" : "quick",
              hostname: tunnelState.hostname ?? null,
              running: info.tunnel.running,
              authorizationHealthy: info.tunnel.authorizationHealthy,
              fallback: Boolean(tunnelState.fallbackReason),
            },
          })
        );
        return;
      }
      check(t(`Workspace recognized (${targetWorkspace.name})`, `已識別工作區（${targetWorkspace.name}）`));
      check(t("Installation bridge started", "安裝級 Bridge 已啟動"));
      if (openAiTunnel && info.tunnel.running) check(t("OpenAI Secure Tunnel connected", "OpenAI Secure Tunnel 已連線"));
      else if (mcpUrl) check(t("Connection established", "連線已建立"));
      say("");
      if (mcpUrl) say(t(`Connection URL: ${mcpUrl}`, `連線位址：${mcpUrl}`));
      else say(t(`Local URL: http://127.0.0.1:${runtime.port}/mcp`, `本機位址：http://127.0.0.1:${runtime.port}/mcp`));
      if (openAiTunnel) {
        say(t("ChatGPT connector: Connection = Tunnel; Authentication = No authentication.", "ChatGPT 連接器：Connection = Tunnel；Authentication = No authentication。"));
      } else {
        say(t("ChatGPT connector: Authentication = OAuth. Run c2c pair only when the authorization form is open.", "ChatGPT 連接器：Authentication = OAuth。請在授權表單開啟後才執行 c2c pair。"));
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- stop / restart

acceptUnusedWorkspaceOption(
  program.command("stop")
    .description("Stop the installation bridge and its connection (all workspaces)")
    .option("--json", "machine-readable output", false)
).action(async (opts: { json: boolean }) => {
  try {
    const stopped = await stopBridge();
    if (opts.json) say(JSON.stringify({ ok: true, stopped }));
    else if (stopped) check(t("Bridge stopped", "Bridge 已停止"));
    else say(t("No bridge is running.", "沒有正在執行的 Bridge。"));
  } catch (error) {
    handleCliError(error, opts.json);
  }
});

program
  .command("restart")
  .description("Restart the installation bridge")
  .option("-w, --workspace <path>")
  .option("--no-tunnel", "restart as a local-only bridge (development)")
  .addOption(new Option("--tunnel", "re-establish the selected connection (default)").hideHelp())
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; tunnel: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      new Workspace(root);
      if (opts.tunnel) validateConnection();
      await stopBridge();
      const { mcpUrl, workspace: targetWorkspace } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      if (opts.json) say(JSON.stringify({ ok: true, workspaceId: targetWorkspace.id, mcpUrl }));
      else {
        check(t(`Bridge restarted (${targetWorkspace.name})`, `Bridge 已重新啟動（${targetWorkspace.name}）`));
        if (mcpUrl) check(t("Connection established", "連線已建立"));
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- status

program
  .command("status")
  .description("Show installation bridge status")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const observation = await findInstallationObservation(undefined, runtimeCompatibility(false));
    if (observation.state === "unknown") {
      if (opts.json) {
        say(
          JSON.stringify({
            ok: false,
            running: null,
            compatible: false,
            state: "unknown",
            lifecycleState: observation.reason,
            diagnosticCode: observation.reason,
            reason: observation.reason,
            expectedContractId: RUNTIME_CONTRACT_ID,
            expectedBuildId: RUNTIME_BUILD_ID,
            recovery:
              observation.reason === "unsupported_state_schema" ||
              observation.reason === "runtime_corrupt" ||
              observation.reason === "corrupt_canonical_state"
                ? "After confirming no previous C2C daemon or tunnel-client is running, reset local C2C state and run setup again."
                : undefined,
          })
        );
      } else {
        cross(t(`Bridge state is uncertain (${observation.reason}); not treated as stopped.`, `Bridge 狀態無法確認（${observation.reason}），不會視為已停止。`));
      }
      return;
    }
    if (observation.state === "stopped") {
      let registry: WorkspaceRegistry;
      try {
        registry = new WorkspaceRegistry();
      } catch (error) {
        const corrupt = {
          ok: false,
          running: false,
          compatible: false,
          state: "corrupt_canonical_state",
          reason: (error as Error).message,
          recovery: "After confirming no previous C2C daemon or tunnel-client is running, reset local C2C state and run setup again.",
        };
        if (opts.json) say(JSON.stringify(corrupt));
        else cross(t(`Cannot read C2C canonical state: ${corrupt.reason}`, `無法讀取 C2C 正式狀態：${corrupt.reason}`));
        return;
      }
      const registered = registry.summaries().find((item) => item.workspaceId === workspace.id);
      let stoppedTunnelDiagnostic: string | undefined;
      let stoppedTunnelProvider: string | undefined;
      try {
        const tunnelState = readInstallationTunnelState();
        const selection = selectTunnelProvider(tunnelState);
        stoppedTunnelProvider = selection.provider;
        const config = openAiRuntimeConfiguration(process.env, tunnelState.tunnelId);
        const binaries = detectTunnelBinaries();
        stoppedTunnelDiagnostic = selection.diagnostic ??
          (selection.provider === "openai-secure" && !config.complete
            ? `OPENAI_CONFIGURATION_INCOMPLETE: missing ${config.missing.join(" and ")}`
            : selection.provider === "openai-secure" && !binaries.tunnelClient
              ? "NEED_OPENAI_TUNNEL_CLIENT"
              : selection.provider.startsWith("cloudflare") && !binaries.cloudflared
                ? "NEED_CLOUDFLARED"
                : undefined);
      } catch (error) {
        stoppedTunnelDiagnostic = (error as Error).message;
      }
      const stopped = {
        ok: false,
        running: false,
        tunnelProvider: stoppedTunnelProvider,
        connectionMode: stoppedTunnelProvider ? stoppedTunnelProvider === "openai-secure" ? "secure" : "pairing" : null,
        tunnelDiagnostic: stoppedTunnelDiagnostic,
        currentWorkspace: {
          workspaceId: workspace.id,
          displayName: workspace.name,
          registered: Boolean(registered),
          enabled: registered?.enabled ?? false,
          available: registered?.available ?? true,
        },
        registeredWorkspaceCount: registry.list().length,
        state: "stopped",
        reason: observation.reason,
      };
      if (opts.json) say(JSON.stringify(stopped));
      else {
        say(t(`Current workspace: ${workspace.name} (${registered ? "registered" : "not registered"})`, `目前工作區：${workspace.name}（${registered ? "已註冊" : "未註冊"}）`));
        say(t("Bridge is stopped. Run c2c start to start it.", "Bridge 已停止。請執行 c2c start 啟動。"));
        if (stoppedTunnelDiagnostic) cross(stoppedTunnelDiagnostic);
      }
      return;
    }
    const runtime = observation.runtime;
    let info: AdminInfo;
    try {
      info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
    } catch (error) {
      const diagnostic = {
        ok: false,
        running: null,
        compatible: false,
        state: "ownership_conflict",
        reason: `admin_authority_unverified: ${(error as Error).message}`,
      };
      if (opts.json) say(JSON.stringify(diagnostic));
      else cross(t(`Cannot verify bridge admin authority: ${diagnostic.reason}`, `無法驗證 Bridge 管理權限：${diagnostic.reason}`));
      return;
    }
    const currentWorkspace = info.workspaces?.find((item) => item.workspaceId === workspace.id) ?? null;
    let tunnelDiagnostic: string | undefined;
    try {
      const tunnelState = readInstallationTunnelState();
      const selection = selectTunnelProvider(tunnelState);
      const openAiConfig = openAiRuntimeConfiguration(process.env, tunnelState.tunnelId);
      const binaries = detectTunnelBinaries();
      tunnelDiagnostic = selection.diagnostic ??
        (info.tunnel.authorizationHealthy === false
          ? info.tunnel.detail ?? "OPENAI_MCP_AUTHORIZATION_UNHEALTHY"
          : !info.tunnel.running && info.tunnel.detail
            ? info.tunnel.detail
            : selection.provider === "openai-secure" && !openAiConfig.complete
            ? `OPENAI_CONFIGURATION_INCOMPLETE: missing ${openAiConfig.missing.join(" and ")}`
            : selection.provider === "openai-secure" && !binaries.tunnelClient
              ? "NEED_OPENAI_TUNNEL_CLIENT"
              : selection.provider.startsWith("cloudflare") && !binaries.cloudflared
                ? "NEED_CLOUDFLARED"
                : undefined);
    } catch (error) {
      tunnelDiagnostic = (error as Error).message;
    }
    const tunnelAuthorizationHealthy = info.tunnel.authorizationHealthy !== false;
    const status = {
      ok: tunnelAuthorizationHealthy,
      running: true,
      compatible: true,
      state: tunnelAuthorizationHealthy ? "healthy" : "tunnel_authorization_unhealthy",
      lifecycleState: tunnelAuthorizationHealthy ? "healthy" : "tunnel_authorization_unhealthy",
      tunnelDiagnostic,
      tunnelAuthorizationHealthy,
      connectionMode: info.tunnel.provider === "openai-secure" ? "secure" : "pairing",
      currentWorkspace: {
        workspaceId: workspace.id,
        displayName: workspace.name,
        registered: currentWorkspace !== null,
        enabled: currentWorkspace?.enabled ?? false,
        available: currentWorkspace?.available ?? true,
      },
      registeredWorkspaceCount: info.workspaces?.length ?? info.workspaceIds?.length ?? 0,
      ...info,
    };
    if (opts.json) {
      say(JSON.stringify(status));
      return;
    }
    say(PRODUCT_NAME);
    say("");
    check(t(`Current workspace: ${workspace.name} (${currentWorkspace ? "registered" : "not registered"})`, `目前工作區：${workspace.name}（${currentWorkspace ? "已註冊" : "未註冊"}）`));
    check(t(`Bridge: running (port ${info.port})`, `Bridge：執行中（連接埠 ${info.port}）`));
    say(t(`Connection profile: ${status.connectionMode}`, `連線設定檔：${status.connectionMode}`));
    if (info.tunnel.authorizationHealthy === false) {
      cross(t(`Connection: ${tunnelDiagnostic ?? "internal authorization unavailable"}`, `連線：${tunnelDiagnostic ?? "內部授權無法使用"}`));
    } else if (info.tunnel.running && info.tunnel.url) {
      check(t(`Connection: ${mcpUrlForTunnel(info)}`, `連線：${mcpUrlForTunnel(info)}`));
    } else {
      say(t("Connection: disabled (local mode)", "連線：未啟用（本機模式）"));
    }
    if (status.connectionMode === "pairing") {
      say(t(`OAuth access granted: ${info.tokenCount > 0 ? "yes" : "no"}`, `OAuth 存取權已授予：${info.tokenCount > 0 ? "是" : "否"}`));
    }
  });

// ---------------------------------------------------------------- doctor

program
  .command("doctor")
  .description("Diagnose and auto-repair the connection")
  .option("-w, --workspace <path>")
  .option("--no-fix", "diagnose only, do not repair")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; fix: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const report: Record<string, { ok: boolean; detail?: string }> = {};
    const results: string[] = [];

    // Node
    const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
    report.node = { ok: nodeMajor >= 20, detail: `v${process.versions.node}` };

    // Codex sandbox writable_roots (so later chats do not need elevation)
    if (opts.fix) {
      const sandbox = trySandboxAllow();
      if (sandbox.ok) {
        report.sandbox = { ok: true, detail: sandbox.alreadyAllowed ? t("already allowlisted", "已在允許清單") : t("added to allowlist", "已加入允許清單") };
        if (sandbox.added) results.push(t("Added the local state directory to the Codex sandbox allowlist", "已將本機狀態目錄加入 Codex 沙箱允許清單"));
      } else {
        report.sandbox = { ok: false, detail: sandbox.error };
      }
    } else {
      try {
        const configPath = getCodexConfigPath();
        const allowed =
          fs.existsSync(configPath) && isStateDirAllowlisted(fs.readFileSync(configPath, "utf8"), getStateDir());
        report.sandbox = { ok: allowed, detail: allowed ? t("already allowlisted", "已在允許清單") : t("not allowlisted", "不在允許清單") };
      } catch (error) {
        report.sandbox = { ok: false, detail: (error as Error).message };
      }
    }

    // Workspace
    let workspace: Workspace | null = null;
    try {
      workspace = new Workspace(root);
      try {
        new WorkspaceRegistry().list();
        report.workspace = { ok: true, detail: workspace.name };
      } catch (error) {
        report.workspace = { ok: false, detail: `canonical registry unavailable: ${(error as Error).message}` };
      }
    } catch (error) {
      report.workspace = { ok: false, detail: (error as Error).message };
    }

    // Bridge
    let runtime: RuntimeState | null = null;
    let bridgeUnknown = false;
    if (workspace) {
      const observation = await findInstallationObservation(undefined, runtimeCompatibility(false));
      if (observation.state === "healthy") {
        runtime = observation.runtime;
      } else if (observation.state === "unknown") {
        bridgeUnknown = true;
        report.bridge = { ok: false, detail: t(`State uncertain (${observation.reason}); auto-repair skipped`, `狀態無法確認（${observation.reason}），未自動修復`) };
      } else if (opts.fix) {
        try {
          runtime = (await ensureBridge(root)).runtime;
          results.push(t("Started the bridge", "已啟動 Bridge"));
        } catch (error) {
          report.bridge = { ok: false, detail: (error as Error).message };
        }
      }
      if (runtime) report.bridge = { ok: true, detail: t(`port ${runtime.port}`, `連接埠 ${runtime.port}`) };
      else report.bridge = report.bridge ?? { ok: false, detail: t("not running", "未執行") };
    }

    // MCP local reachability (401 without token means MCP + auth both work)
    if (runtime) {
      try {
        const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
        });
        report.mcp = { ok: response.status === 401, detail: t(`unauthorized request returned ${response.status}`, `未授權請求回傳 ${response.status}`) };
        report.authorization = { ok: response.status === 401 };
      } catch (error) {
        report.mcp = { ok: false, detail: (error as Error).message };
      }
    }

    // Tunnel + remote reachability. If the installation once had a public URL,
    // a full quit reclaims it — restore one tunnel and tell the Skill to update
    // the installation Connector (never treat that as "local mode").
    const lastEndpoint = workspace ? previousInstallationEndpoint(workspace.id) : null;
    const connectorName = workspace
      ? connectorNameFor({
          workspaceName: PRODUCT_NAME,
          workspaceId: INSTALLATION_ENDPOINT_ID,
          previousName: lastEndpoint?.connectorName,
          hadEndpointBefore: Boolean(lastEndpoint),
        })
      : PRODUCT_NAME;
    let tunnelState: ReturnType<typeof readInstallationTunnelState> | null = null;
    let tunnelStateError: string | null = null;
    if (workspace) {
      try {
        tunnelState = readInstallationTunnelState();
      } catch (error) {
        tunnelStateError = (error as Error).message;
      }
    }
    const tunnelSelection = tunnelState ? selectTunnelProvider(tunnelState) : null;
    const openAiConfig = tunnelState
      ? openAiRuntimeConfiguration(process.env, tunnelState.tunnelId)
      : null;
    const tunnelBinaries = detectTunnelBinaries();
    const namedReady = tunnelState ? isNamedTunnelReady(tunnelState) : false;
    let namedRepair: { needed: boolean; userMessage?: string } = { needed: false };
    let chatgptRepair: {
      needed: boolean;
      reason?: string;
      connectorAction: "none" | "create" | "update";
      connectorName: string;
      userMessage?: string;
      mcpUrl: string | null;
      previousMcpUrl: string | null;
      pages: {
        developerMode: string;
        plugins: string;
        createConnector: string;
      };
    } = {
      needed: false,
      connectorAction: "none",
      connectorName,
      mcpUrl: lastEndpoint?.mcpUrl ?? null,
      previousMcpUrl: lastEndpoint?.mcpUrl ?? null,
      pages: {
        developerMode: CHATGPT_DEVELOPER_MODE_URL,
        plugins: CHATGPT_PLUGINS_URL,
        createConnector: CHATGPT_CREATE_CONNECTOR_URL,
      },
    };

    if (tunnelStateError) {
      report.tunnel = { ok: false, detail: tunnelStateError };
    } else if (runtime) {
      let info: AdminInfo | null;
      try {
        info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
      } catch (error) {
        const detail = `admin_authority_unverified: ${(error as Error).message}`;
        report.bridge = { ok: false, detail };
        report.mcp = { ok: false, detail };
        report.authorization = { ok: false, detail };
        report.tunnel = { ok: false, detail: "Bridge admin authority unavailable; tunnel diagnosis skipped" };
        bridgeUnknown = true;
        info = null;
      }
      if (info && tunnelSelection && info.tunnel.provider !== tunnelSelection.provider) {
        report.tunnel = { ok: false, detail: "CONNECTION_PROFILE_MISMATCH: run c2c restart to apply the selected profile." };
        info = null;
      }
      if (info && info.buildId !== RUNTIME_BUILD_ID) {
        report.tunnel = { ok: false, detail: "BRIDGE_UPDATE_REQUIRED: run c2c restart before repairing the public connection." };
        info = null;
      }
      if (info) {
      const openAiTunnel = info.tunnel.provider === "openai-secure";
      const expectedPublic = Boolean(lastEndpoint?.publicUrl) || namedReady || openAiTunnel;
      const binaries = tunnelBinaries;
      const providerProblems = openAiTunnel
        ? [
            ...(openAiConfig && !openAiConfig.tunnelId ? ["NEED_OPENAI_TUNNEL_ID"] : []),
            ...(openAiConfig && !openAiConfig.apiKeyPresent ? ["NEED_OPENAI_TUNNEL_KEY"] : []),
            ...(!binaries.tunnelClient ? ["NEED_OPENAI_TUNNEL_CLIENT"] : []),
          ]
        : info.tunnel.provider === "cloudflare-quick" || info.tunnel.provider === "cloudflare-named"
          ? [...(!binaries.cloudflared ? ["NEED_CLOUDFLARED"] : [])]
          : [];
      const providerRequired = Boolean(tunnelState?.preference && tunnelState.preference !== "unset") || expectedPublic;
      const authorizationUnhealthy = openAiTunnel && info.tunnel.authorizationHealthy === false;
      if (authorizationUnhealthy) {
        report.tunnel = {
          ok: false,
          detail: info.tunnel.detail ?? "OPENAI_MCP_AUTHORIZATION_UNHEALTHY",
        };
      } else if (providerRequired && providerProblems.length > 0 && !info.tunnel.running) {
        report.tunnel = { ok: false, detail: providerProblems.join(", ") };
      }
      let currentUrl = info.publicUrl ?? info.tunnel.url;
      let healthy = openAiTunnel ? info.tunnel.running && !authorizationUnhealthy : false;
      if (currentUrl && !openAiTunnel) {
        try {
          const response = await fetch(`${currentUrl}/health`, { signal: AbortSignal.timeout(8000) });
          healthy = response.ok;
        } catch {
          healthy = false;
        }
      }

      if ((!currentUrl || !healthy) && opts.fix && (expectedPublic || info.tunnel.running) && providerProblems.length === 0) {
        try {
          const started = await adminFetch<TunnelStartResponse>(runtime, "POST", "/admin/tunnel/start", 90_000);
          if (started.url) {
            const previousUrl = lastEndpoint?.publicUrl;
            info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
            currentUrl = info.publicUrl ?? started.url;
            healthy = openAiTunnel ? info.tunnel.running && info.tunnel.authorizationHealthy !== false : true;
            const sameAddress =
              previousUrl && normalizePublicUrl(previousUrl) === normalizePublicUrl(currentUrl);
            if (healthy) {
              results.push(sameAddress ? t("Connection restored", "連線已恢復") : t("Connection restored (address changed)", "連線已恢復（位址已變更）"));
            } else {
              report.tunnel = {
                ok: false,
                detail: info.tunnel.detail ?? "OPENAI_MCP_AUTHORIZATION_UNHEALTHY",
              };
            }
          }
        } catch (error) {
          report.tunnel = { ok: false, detail: (error as Error).message };
        }
      }

      if (currentUrl && healthy) {
        report.tunnel = { ok: true, detail: currentUrl };
        const nextMcp = openAiTunnel ? currentUrl : mcpUrlFromPublic(currentUrl);
        const action = connectorAction(lastEndpoint?.mcpUrl, nextMcp);
        const boundName = nextMcp
          ? persistWorkspaceEndpoint({
              workspaceId: INSTALLATION_ENDPOINT_ID,
              workspaceName: PRODUCT_NAME,
              port: runtime.port,
              publicUrl: currentUrl,
              mcpUrl: nextMcp,
              previous: lastEndpoint,
            })
          : connectorName;
        chatgptRepair = {
          ...chatgptRepair,
          needed: action === "update",
          reason: action === "update" ? "address_reclaimed" : undefined,
          connectorAction: action,
          connectorName: boundName,
          userMessage: action === "update" ? reclaimUserMessage(boundName) : undefined,
          mcpUrl: nextMcp,
          previousMcpUrl: lastEndpoint?.mcpUrl ?? null,
        };
        if (action === "update") {
          results.push(t(`Connection address changed; update "${boundName}"`, `連線位址已變更；請更新「${boundName}」`));
        }
      } else if (namedReady) {
        report.tunnel = report.tunnel ?? { ok: false, detail: "NAMED_TUNNEL_DOWN" };
        namedRepair = { needed: true, userMessage: namedRepairMessage() };
      } else if (expectedPublic) {
        report.tunnel = report.tunnel ?? { ok: false, detail: info.tunnel.detail ?? t("Connection not restored", "連線尚未恢復") };
        chatgptRepair = {
          ...chatgptRepair,
          needed: !openAiTunnel && Boolean(lastEndpoint?.mcpUrl),
          reason: "address_reclaimed",
          connectorAction: "update",
          connectorName,
          userMessage: reclaimUserMessage(connectorName),
          mcpUrl: null,
        };
      } else if (!currentUrl) {
        report.tunnel = { ok: true, detail: t("disabled (local mode)", "未啟用（本機模式）") };
      } else {
        report.tunnel = { ok: false, detail: t("Public address unreachable", "無法存取公開位址") };
      }
      }
    } else if (bridgeUnknown) {
      report.tunnel = report.tunnel ?? { ok: false, detail: t("Bridge state uncertain; connector repair skipped", "Bridge 狀態無法確認；未執行連接器修復") };
    } else if (namedReady) {
      report.tunnel = { ok: false, detail: "NAMED_TUNNEL_DOWN" };
      namedRepair = { needed: true, userMessage: namedRepairMessage() };
    } else if (lastEndpoint?.publicUrl) {
      report.tunnel = { ok: false, detail: t("Connection not running", "連線未執行") };
      chatgptRepair = {
        ...chatgptRepair,
        needed: true,
        reason: "address_reclaimed",
        connectorAction: "update",
        connectorName,
        userMessage: reclaimUserMessage(connectorName),
      };
    }

    if (tunnelSelection?.diagnostic) {
      report.tunnel = { ok: false, detail: tunnelSelection.diagnostic };
    } else if (tunnelSelection?.provider === "openai-secure" && openAiConfig && !openAiConfig.complete) {
      report.tunnel = {
        ok: false,
        detail: `OPENAI_CONFIGURATION_INCOMPLETE: missing ${openAiConfig.missing.join(" and ")}`,
      };
    } else if (
      tunnelSelection?.provider === "openai-secure" &&
      (tunnelState?.preference === "openai" || openAiConfig?.complete) &&
      !tunnelBinaries.tunnelClient
    ) {
      report.tunnel = { ok: false, detail: "NEED_OPENAI_TUNNEL_CLIENT" };
    } else if (
      tunnelSelection &&
      tunnelSelection.provider.startsWith("cloudflare") &&
      tunnelState?.preference !== "unset" &&
      !tunnelBinaries.cloudflared
    ) {
      report.tunnel = { ok: false, detail: "NEED_CLOUDFLARED" };
    }

    const ok = Object.values(report).every((item) => item.ok) && !namedRepair.needed;
    if (!ok) process.exitCode = 1;
    if (opts.json) {
      say(JSON.stringify({ ok, connectionMode: tunnelState ? connectionMode(tunnelState) : null, report, repairs: results, chatgptRepair, namedRepair }));
      return;
    }
    say(`${PRODUCT_NAME} Doctor`);
    say("");
    const labels: Record<string, string> = {
      node: "Node.js",
      sandbox: "Sandbox",
      workspace: "Workspace",
      bridge: "Bridge",
      mcp: "MCP",
      authorization: "MCP authorization",
      tunnel: "Tunnel",
    };
    let allOk = true;
    for (const [key, value] of Object.entries(report)) {
      const label = labels[key] ?? key;
      if (value.ok) check(`${label}${value.detail ? ` (${value.detail})` : ""}`);
      else {
        cross(`${label}${value.detail ? `: ${value.detail}` : ""}`);
        allOk = false;
      }
    }
    for (const repair of results) say(`· ${repair}`);
    say("");
    if (namedRepair.needed && namedRepair.userMessage) {
      say(namedRepair.userMessage);
      say("");
    }
    if (chatgptRepair.needed && chatgptRepair.userMessage) {
      say(chatgptRepair.userMessage);
      if (chatgptRepair.mcpUrl) say(t(`New connection URL: ${chatgptRepair.mcpUrl}`, `新的連線位址：${chatgptRepair.mcpUrl}`));
      say("");
    }
    say(
      allOk && !chatgptRepair.needed && !namedRepair.needed
        ? t("Everything looks good.", "所有檢查皆通過。")
        : chatgptRepair.needed
          ? t("Local setup is ready; replace the connection in ChatGPT using the new URL.", "本機設定已就緒；請使用新位址在 ChatGPT 重新建立連線。")
          : namedRepair.needed
            ? t("The named tunnel is down. Sign in to Cloudflare first.", "固定網域連線無法使用。請先登入 Cloudflare。")
            : t("Some issues remain. Check c2c connection status or try c2c restart.", "仍有問題未解決。請檢查 c2c connection status 或嘗試 c2c restart。")
    );
    if (!allOk || namedRepair.needed) process.exitCode = 1;
  });

// ---------------------------------------------------------------- pair / unpair

acceptUnusedWorkspaceOption(
  program.command("pair")
    .description("Generate a one-time code (Pairing mode only; all workspaces)")
    .option("--json", "machine-readable output", false)
).action(async (opts: { json: boolean }) => {
    try {
      requirePairingMode();
      const observation = await findInstallationObservation(undefined, runtimeCompatibility());
      if (observation.state !== "healthy") {
        throw new Error(t("Bridge is not ready. Run c2c start from a workspace before pairing.", "Bridge 尚未就緒。請先從工作區執行 c2c start，再進行配對。"));
      }
      const runtime = observation.runtime;
      const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
      if (opts.json) say(JSON.stringify({ ok: true, pairingCode: pairing.code, expiresAt: pairing.expiresAt }));
      else {
        say(t(`Pairing code: ${pairing.code}`, `配對碼：${pairing.code}`));
        say(t(`Valid for ${Math.round((pairing.expiresAt - Date.now()) / 60000)} minutes; one use only.`, `${Math.round((pairing.expiresAt - Date.now()) / 60000)} 分鐘內有效，僅限使用一次。`));
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

acceptUnusedWorkspaceOption(
  program.command("unpair")
    .description("Revoke Pairing access for ALL registered workspaces")
    .option("--json", "machine-readable output", false)
).action(async (opts: { json: boolean }) => {
  try {
    requirePairingMode();
    const installation = await findInstallationObservation(undefined, runtimeCompatibility(false));
    if (installation.state === "unknown") throw new Error(`Bridge state is uncertain (${installation.reason}); access was not changed.`);
    const revoked = installation.state === "healthy"
      ? (await adminFetch<{ revoked: number }>(installation.runtime, "POST", "/admin/revoke-all")).revoked
      : new AuthStore(INSTALLATION_ENDPOINT_ID).revokeAll();
    if (opts.json) say(JSON.stringify({ ok: true, revoked }));
    else check(t("Pairing access revoked for all registered workspaces", "所有已註冊工作區的配對存取權已撤銷"));
  } catch (error) {
    handleCliError(error, opts.json);
  }
});

// ---------------------------------------------------------------- logs / workspace / record

acceptUnusedWorkspaceOption(
  program.command("logs")
    .description("Show recent bridge logs")
    .option("-n, --lines <n>", "number of lines", "50")
    .option("--verbose", "include debug detail", false)
).action((opts: { lines: string; verbose: boolean }) => {
    const candidates = [
      path.join(getStateDir(), "logs", "bridge-installation.out.log"),
      path.join(getStateDir(), "logs", "bridge.log"),
    ];
    let shown = false;
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      const filtered = opts.verbose ? lines : lines.filter((line) => !line.includes(" DEBUG "));
      say(filtered.slice(-parseInt(opts.lines, 10)).join("\n"));
      shown = true;
    }
    if (!shown) say(t("No logs yet.", "尚無日誌。"));
  });

const workspaceCmd = program
  .command("workspace")
  .description("Manage registered workspaces or show the current workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const project = workspace.detectProject();
      const data = { workspaceId: workspace.id, name: workspace.name, root: workspace.root, ...project };
      if (opts.json) say(JSON.stringify(data));
      else {
        say(t(`Workspace: ${data.name} (${data.workspaceId})`, `工作區：${data.name}（${data.workspaceId}）`));
        say(t(`Type: ${data.projectType}  Languages: ${data.languages.join(", ") || "-"}`, `類型：${data.projectType}  語言：${data.languages.join(", ") || "-"}`));
        say(t(`Path: ${data.root}`, `路徑：${data.root}`));
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

function emitWorkspaceList(registry: WorkspaceRegistry, json: boolean): void {
  const workspaces = registry.summaries();
  if (json) {
    say(JSON.stringify({ ok: true, defaultWorkspaceId: registry.defaultWorkspaceId(), workspaces }));
    return;
  }
  if (workspaces.length === 0) {
    say(t("No workspaces registered. Run c2c workspace add [path] to add one.", "尚未註冊工作區。請執行 c2c workspace add [path] 新增。"));
    return;
  }
  for (const item of workspaces) {
    const state = !item.enabled ? "disabled" : item.available ? "available" : "unavailable";
    say(`${item.isDefault ? "*" : " "} ${item.alias} (${item.workspaceId}) — ${state}${item.branch ? ` — ${item.branch}` : ""}`);
  }
}

workspaceCmd
  .command("list")
  .description("List registered workspaces without exposing local roots")
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }, command) => {
    const json = opts.json || Boolean((command.parent?.opts() as { json?: boolean } | undefined)?.json);
    try {
      emitWorkspaceList(new WorkspaceRegistry(), json);
    } catch (error) {
      handleCliError(error, json);
    }
  });

for (const commandName of ["add", "register"]) {
  workspaceCmd
    .command(commandName, { hidden: commandName === "register" })
    .description("Register a workspace (defaults to the current directory)")
    .argument("[path]", "workspace root")
    .addOption(new Option("-w, --workspace <path>", "legacy spelling of [path]").hideHelp())
    .option("--alias <alias>", "human-readable workspace alias")
    .option("--json", "machine-readable output", false)
    .action((workspacePath: string | undefined, opts: { workspace?: string; alias?: string; json: boolean }, command) => {
      const parentOpts = command.parent?.opts() as { workspace?: string; json?: boolean } | undefined;
      const json = opts.json || Boolean(parentOpts?.json);
      try {
        const paths = [workspacePath, opts.workspace, parentOpts?.workspace].filter((value) => value !== undefined);
        if (paths.length > 1) throw new Error(t("Use either [path] or --workspace, not both.", "請使用 [path] 或 --workspace 其中一種，不要重複指定。"));
        const record = new WorkspaceRegistry().register(resolveWorkspace(paths[0]), { alias: opts.alias });
        if (json) say(JSON.stringify({ ok: true, workspaceId: record.workspaceId, alias: record.alias }));
        else check(t(`Workspace added: ${record.alias} (${record.workspaceId})`, `已新增工作區：${record.alias}（${record.workspaceId}）`));
      } catch (error) {
        handleCliError(error, json);
      }
    });
}

function workspaceMutationCommand(
  name: "enable" | "disable" | "remove" | "set-default" | "default",
  description: string,
  mutate: (registry: WorkspaceRegistry, selector: string) => unknown
): void {
  workspaceCmd
    .command(name, { hidden: name === "default" })
    .description(description)
    .argument("<workspace>", "workspace id or alias")
    .option("--json", "machine-readable output", false)
    .action((selector: string, opts: { json: boolean }, command) => {
      const json = opts.json || Boolean((command.parent?.opts() as { json?: boolean } | undefined)?.json);
      try {
        const result = mutate(new WorkspaceRegistry(), selector);
        const safeWorkspace =
          result && typeof result === "object"
            ? Object.fromEntries(Object.entries(result).filter(([key]) => key !== "root"))
            : result;
        if (json) say(JSON.stringify({ ok: true, workspace: safeWorkspace }));
        else check(`${name}: ${selector}`);
      } catch (error) {
        handleCliError(error, json);
      }
    });
}

workspaceMutationCommand("enable", "Enable a registered workspace", (registry, selector) => registry.setEnabled(selector, true));
workspaceMutationCommand("disable", "Disable a registered workspace", (registry, selector) => registry.setEnabled(selector, false));
workspaceMutationCommand("remove", "Remove a workspace from this installation", (registry, selector) => registry.remove(selector));
workspaceMutationCommand("set-default", "Choose the default workspace", (registry, selector) => registry.setDefault(selector));
workspaceMutationCommand("default", "Choose the default workspace", (registry, selector) => registry.setDefault(selector));

// ---------------------------------------------------------------- sandbox-allow (Codex writable_roots, macOS + Windows)

acceptUnusedWorkspaceOption(
  program
    .command("sandbox-allow")
    .description("Add the local settings directory to the Codex sandbox allowlist")
    .option("--json", "machine-readable output", false)
)
  .action((opts: { json: boolean }) => {
    const result = trySandboxAllow();
    if (opts.json) {
      say(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (!result.ok) {
      cross(t(`Cannot write the Codex sandbox allowlist: ${result.error}`, `無法寫入 Codex 沙箱允許清單：${result.error}`));
      process.exitCode = 1;
      return;
    }
    if (result.alreadyAllowed) check(t("Sandbox allowlist ready; no elevation needed for later sessions", "沙箱允許清單已就緒；後續對話無需提升權限"));
    else check(t("Local state directory added to the Codex sandbox allowlist", "已將本機狀態目錄加入 Codex 沙箱允許清單"));
  });

// ---------------------------------------------------------------- update-check (once per local day)

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function runGit(args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 8000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    windowsHide: true,
  });
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim() };
}

acceptUnusedWorkspaceOption(
  program
    .command("update-check")
    .description("Check GitHub for a newer version (real check at most once per local day)")
    .option("--force", "check even if already checked today", false)
    .option("--json", "machine-readable output", false)
)
  .action((opts: { force: boolean; json: boolean }) => {
    const file = path.join(getStateDir(), "update-check.json");
    const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local tz
    let last: { date?: string; updateAvailable?: boolean } = {};
    try {
      last = JSON.parse(fs.readFileSync(file, "utf8")) as typeof last;
    } catch {
      /* first run */
    }

    const emit = (data: {
      checked: boolean;
      updateAvailable: boolean;
      localCommit?: string;
      remoteCommit?: string;
      note?: string;
    }): void => {
      if (opts.json) say(JSON.stringify({ ok: true, version: VERSION, ...data }));
      else if (data.updateAvailable) say(t(`Update available (local ${data.localCommit?.slice(0, 7)} -> remote ${data.remoteCommit?.slice(0, 7)}).`, `有可用更新（本機 ${data.localCommit?.slice(0, 7)} → 遠端 ${data.remoteCommit?.slice(0, 7)}）。`));
      else say(data.note ?? t("Already up to date.", "已是最新版本。"));
    };

    if (!opts.force && last.date === today) {
      emit({ checked: false, updateAvailable: last.updateAvailable ?? false, note: t("Already checked for updates today.", "今天已檢查過更新。") });
      return;
    }

    const local = runGit(["rev-parse", "HEAD"]);
    const remote = runGit(["ls-remote", "origin", "HEAD"]);
    if (!local.ok || !remote.ok || !remote.stdout) {
      // Offline or not a git checkout: skip quietly and retry tomorrow-ish (do not
      // record the date so a transient failure does not suppress the daily check).
      emit({ checked: false, updateAvailable: false, note: t("Update check skipped (offline or not a git installation).", "已略過更新檢查（離線或非 git 安裝）。") });
      return;
    }
    const remoteCommit = remote.stdout.split(/\s/)[0];
    const updateAvailable = remoteCommit !== local.stdout;
    fs.mkdirSync(getStateDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ date: today, updateAvailable, remoteCommit }), { mode: 0o600 });
    emit({ checked: true, updateAvailable, localCommit: local.stdout, remoteCommit });
  });

// ---------------------------------------------------------------- session (ChatGPT conversation / Project memory)

const session = program
  .command("session")
  .description("Remember the ChatGPT Project and conversation for this workspace");

session
  .command("get", { isDefault: true })
  .description("Show the saved ChatGPT conversation / Project for this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const saved = readSession(workspace.id);
    const conversation = resolveConversation(saved);
    if (opts.json) say(JSON.stringify({ ok: true, session: saved, conversation }));
    else if (!saved) {
      say(t("No ChatGPT session saved. New workspaces default to Project mode.", "尚未儲存 ChatGPT 對話。新工作區預設使用 Project 模式。"));
    } else {
      say(t(`Mode: ${conversation.mode}`, `模式：${conversation.mode === "project" ? "Project" : "長對話"}`));
      if (conversation.projectUrl) say(t(`Project: ${conversation.projectUrl}`, `Project：${conversation.projectUrl}`));
      if (saved.title) say(t(`Session: ${saved.title}`, `對話：${saved.title}`));
      if (saved.url) say(t(`Chat: ${saved.url}`, `聊天：${saved.url}`));
      if (saved.connectorName) say(t(`Connector: ${saved.connectorName}`, `連接器：${saved.connectorName}`));
      if (saved.taskId) say(t(`Task: ${saved.taskId} (iteration ${saved.iteration ?? 0}, ${saved.lastState ?? "?"})`, `任務：${saved.taskId}（第 ${saved.iteration ?? 0} 輪，${saved.lastState ?? "?"}）`));
      if (saved.checkpoint) {
        say(t(
          `Checkpoint: ${saved.checkpoint.protocolState} / waiting for ${saved.checkpoint.waitingFor} (iteration ${saved.checkpoint.iteration})`,
          `檢查點：${saved.checkpoint.protocolState} / 等待 ${saved.checkpoint.waitingFor}（第 ${saved.checkpoint.iteration} 輪）`
        ));
      }
    }
  });

session
  .command("set")
  .description("Save the ChatGPT Project and/or conversation for this workspace")
  .option("-w, --workspace <path>")
  .option("--url <url>", "ChatGPT conversation URL from the address bar")
  .option("--title <title>")
  .option("--task <id>")
  .option("--iteration <n>")
  .option("--state <state>", "last protocol state, e.g. EXECUTED")
  .option("--mode <mode>", "long-chat or project")
  .option("--project-url <url>", "ChatGPT Project collection URL (…/g/g-p-…/project)")
  .option("--connector-name <name>", "exact connector title for this workspace")
  .option("--protocol-state <state>", "checkpoint protocol state, e.g. EXECUTED_SENT")
  .option("--waiting-for <who>", "none | GPT_PLAN | GPT_REVIEW | USER")
  .option("--goal <text>", "original task goal for resume / HANDOFF")
  .option("--completed-subtasks <text>")
  .option("--known-issues <text>")
  .option("--next-step <text>")
  .option("--clear-checkpoint", "drop the active checkpoint (task DONE)", false)
  .action(
    (opts: {
      workspace?: string;
      url?: string;
      title?: string;
      task?: string;
      iteration?: string;
      state?: string;
      mode?: string;
      projectUrl?: string;
      connectorName?: string;
      protocolState?: string;
      waitingFor?: string;
      goal?: string;
      completedSubtasks?: string;
      knownIssues?: string;
      nextStep?: string;
      clearCheckpoint: boolean;
    }) => {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const modeRaw = opts.mode?.trim().toLowerCase();
      if (modeRaw && modeRaw !== "long-chat" && modeRaw !== "project") {
        throw new Error("mode must be long-chat or project");
      }
      const protocolRaw = opts.protocolState?.trim().toUpperCase();
      if (protocolRaw && !PROTOCOL_STATES.includes(protocolRaw as ProtocolState)) {
        throw new Error(`protocol-state must be one of ${PROTOCOL_STATES.join(", ")}`);
      }
      const waitingRaw = opts.waitingFor?.trim();
      const waitingNorm = waitingRaw
        ? waitingRaw.toLowerCase() === "none"
          ? "none"
          : waitingRaw.toUpperCase()
        : undefined;
      if (waitingNorm && !WAITING_FOR.includes(waitingNorm as WaitingFor)) {
        throw new Error(`waiting-for must be one of ${WAITING_FOR.join(", ")}`);
      }
      const saved = mergeSession(readSession(workspace.id), {
        url: opts.url,
        title: opts.title,
        taskId: opts.task,
        iteration: opts.iteration ? parseInt(opts.iteration, 10) : undefined,
        lastState: opts.state,
        conversationMode: modeRaw as ConversationMode | undefined,
        projectUrl: opts.projectUrl,
        connectorName: opts.connectorName,
        clearCheckpoint: opts.clearCheckpoint,
        checkpoint: protocolRaw
          ? {
              protocolState: protocolRaw as ProtocolState,
              waitingFor: (waitingNorm as WaitingFor | undefined) ?? undefined,
              originalGoal: opts.goal,
              completedSubtasks: opts.completedSubtasks,
              knownIssues: opts.knownIssues,
              nextExpectedStep: opts.nextStep,
            }
          : undefined,
      });
      writeSession(workspace.id, saved);
      if (saved.projectUrl && saved.conversationMode === "project") {
        check(t("ChatGPT Project saved; open or reuse chats from the Project page", "已儲存 ChatGPT Project；後續可從 Project 頁面建立或重用對話"));
      } else {
        check(t("ChatGPT session saved for later tasks", "已儲存 ChatGPT 對話供後續任務使用"));
      }
    }
  );

session
  .command("clear")
  .description("Forget the current ChatGPT chat (Project binding is kept)")
  .option("-w, --workspace <path>")
  .action((opts: { workspace?: string }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const result = clearChatPointer(workspace.id);
    if (!result.cleared) say(t("No ChatGPT session saved.", "尚未儲存 ChatGPT 對話。"));
    else if (result.keptProject) check(t("Current chat cleared; Project binding kept", "已清除目前聊天；保留 Project 綁定"));
    else check(t("Session cleared; the next task will open a new ChatGPT chat", "已清除對話；下一個任務會建立新的 ChatGPT 聊天"));
  });

const prefsCmd = program
  .command("prefs")
  .description("Manage this installation's language and ChatGPT setup preferences");

acceptUnusedWorkspaceOption(
  prefsCmd
    .command("get", { isDefault: true })
    .description("Show remembered ChatGPT setup choices (not per workspace)")
    .option("--json", "machine-readable output", false)
)
  .action((opts: { json: boolean }) => {
    const prefs = readUiPrefs();
    if (opts.json) {
      say(JSON.stringify({ ok: true, ...prefs }));
      return;
    }
    say(t(`Language: ${prefs.language}`, `語言：${prefs.language}`));
    say(prefs.developerModeEnabled ? t("Developer mode: remembered as enabled", "開發人員模式：已記住啟用狀態") : t("Developer mode: not remembered", "開發人員模式：尚未記住"));
    if (prefs.setupMode === "auto") say(t("Setup: AI-assisted (preview)", "設定方式：AI 協助（預覽版）"));
    else if (prefs.setupMode === "manual") say(t("Setup: guided manual", "設定方式：手動教學"));
    else say(t("Setup: not selected", "設定方式：尚未選擇"));
  });

acceptUnusedWorkspaceOption(
  prefsCmd
    .command("set")
    .description("Save a ChatGPT setup choice for this machine")
    .option("--developer-mode", "remember that ChatGPT developer mode is on", false)
    .option("--setup-mode <mode>", "auto (preview) or manual")
    .option("--language <locale>", "en (default) or zh-TW; never inferred from OS locale")
    .option("--json", "machine-readable output", false)
)
  .action((opts: { developerMode: boolean; setupMode?: string; language?: string; json: boolean }) => {
    try {
      const modeRaw = opts.setupMode?.trim().toLowerCase();
      if (modeRaw && !SETUP_MODES.includes(modeRaw as SetupMode)) {
        throw new Error(`setup-mode must be one of ${SETUP_MODES.join(", ")}`);
      }
      const languageRaw = opts.language?.trim();
      if (languageRaw !== undefined && !LANGUAGES.includes(languageRaw as Language)) {
        throw new Error(`language must be one of ${LANGUAGES.join(", ")}`);
      }
      if (!opts.developerMode && !modeRaw && !languageRaw) {
        throw new Error("nothing to save: pass --language, --developer-mode, or --setup-mode");
      }
      const prefs = mergeUiPrefs({
        developerModeEnabled: opts.developerMode ? true : undefined,
        setupMode: modeRaw as SetupMode | undefined,
        language: languageRaw as Language | undefined,
      });
      if (opts.json) {
        say(JSON.stringify({ ok: true, ...prefs }));
        return;
      }
      if (languageRaw) check(t(`Language saved: ${prefs.language}`, `語言已儲存：${prefs.language}`));
      if (opts.developerMode) check(t("Developer mode enabled preference saved", "已儲存開發人員模式啟用偏好"));
      if (modeRaw === "auto") check(t("AI-assisted setup preference saved (preview)", "已儲存 AI 協助設定偏好（預覽版）"));
      if (modeRaw === "manual") check(t("Guided manual setup preference saved", "已儲存手動教學設定偏好"));
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

program
  .command("record", { hidden: true })
  .description("Record a Codex execution summary (used by the Skill)")
  .option("-w, --workspace <path>")
  .requiredOption("--task <id>")
  .requiredOption("--iteration <n>", "non-negative execution iteration", parseNonNegativeInteger)
  .option("--changed-files <filesOrCount>", "comma-separated files or a count", "0")
  .option("--tests <summary>", "e.g. '27 passed'")
  .option("--exit-status <status>", "ok | failed | blocked", "ok")
  .option("--notes <text>")
  .option("--command <text>", "command whose output may be offered to ChatGPT")
  .option("--output <text>", "command output (prefer --output-file for long logs)")
  .option("--output-file <path>", "read command output from a local file")
  .option("--exit-code <n>", "numeric exit code of that command", parseInteger)
  .action(
    (opts: {
      workspace?: string;
      task: string;
      iteration: number;
      changedFiles: string;
      tests?: string;
      exitStatus: string;
      notes?: string;
      command?: string;
      output?: string;
      outputFile?: string;
      exitCode?: number;
    }) => {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const changed = parseChangedFiles(opts.changedFiles);
      let outputId: number | undefined;
      let outputAvailable = false;
      const rawOutput =
        opts.outputFile !== undefined
          ? readCappedUtf8(path.resolve(opts.outputFile), MAX_RECORD_OUTPUT_READ)
          : opts.output;
      if (opts.command && rawOutput !== undefined) {
        const savedOutput = saveExecutionOutput(workspace.id, {
          command: opts.command,
          raw: rawOutput,
          exitCode: opts.exitCode ?? null,
          taskId: opts.task,
          iteration: opts.iteration,
        });
        outputId = savedOutput.id;
        outputAvailable = savedOutput.allowed;
      }
      appendExecutionRecord(workspace.id, {
        taskId: opts.task,
        iteration: opts.iteration,
        changedFiles: changed,
        tests: opts.tests ?? null,
        exitStatus: opts.exitStatus,
        timestamp: new Date().toISOString(),
        notes: opts.notes?.slice(0, 400),
        outputId,
        outputAvailable,
      });
      if (outputId !== undefined && !outputAvailable) check(t("Execution summary recorded (output withheld from ChatGPT)", "已記錄執行摘要（輸出未開放給 ChatGPT）"));
      else if (outputId !== undefined) check(t("Execution summary and output recorded", "已記錄執行摘要與輸出"));
      else check(t("Execution summary recorded", "已記錄執行摘要"));
    }
  );

const connection = program.command("connection").description("Manage the installation's Secure Tunnel or Pairing profile");
const tunnelCmd = program.command("tunnel", { hidden: true }).description("Legacy alias for connection configuration");

for (const parent of [connection, tunnelCmd]) {
  acceptUnusedWorkspaceOption(
    parent.command("status", { isDefault: true })
      .description("Show the selected connection profile and missing configuration")
      .option("--zone <domain>", "preview a Pairing named hostname")
      .option("--json", "machine-readable output", false)
  ).action(async (opts: { zone?: string; json: boolean }) => {
    try {
      const payload = { ...connectionPayload(opts.zone), ...(await tunnelLiveState()) };
      if (opts.json) say(JSON.stringify(payload));
      else {
        say(t(`Connection: ${payload.selectedModeLabel}`, `連線：${payload.selectedModeLabel}`));
        if (payload.hostname) say(t(`Hostname: ${payload.hostname}`, `主機名稱：${payload.hostname}`));
        say(t(`Bridge: ${payload.bridgeRunning ? "running" : "stopped"}; connection: ${payload.tunnelRunning ? "running" : "stopped"}`, `Bridge：${payload.bridgeRunning ? "執行中" : "已停止"}；連線：${payload.tunnelRunning ? "執行中" : "已停止"}`));
        if (payload.liveProvider && payload.liveProvider !== payload.provider) {
          cross(t(`CONNECTION_PROFILE_MISMATCH: live provider is ${payload.liveProvider}; run c2c restart.`, `CONNECTION_PROFILE_MISMATCH: 執行中的連線方式為 ${payload.liveProvider}；請執行 c2c restart。`));
        }
        if (payload.diagnostic) cross(String(payload.diagnostic));
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

  acceptUnusedWorkspaceOption(
    parent.command("login")
      .description("Sign in to Cloudflare (Pairing mode only)")
      .option("--json", "machine-readable output", false)
  ).action(async (opts: { json: boolean }) => {
    try {
      requirePairingMode();
      if (!opts.json) say(namedLoginPrompt());
      await new ProcessCloudflaredAccount().login();
      const payload = { ok: true, loggedIn: hasCloudflaredCert() };
      if (opts.json) say(JSON.stringify(payload));
      else check(t("Signed in to Cloudflare", "已登入 Cloudflare"));
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });
}

interface ConnectionChoiceOptions {
  transport?: string;
  zone?: string;
  hostname?: string;
  json: boolean;
}

async function useConnection(mode: string, opts: ConnectionChoiceOptions): Promise<void> {
  try {
    let candidate: TunnelState;
    if (mode === "secure") {
      if (opts.transport || opts.zone || opts.hostname) {
        throw new Error("--transport, --zone, and --hostname are only available in Pairing mode.");
      }
      const tunnelId = validateOpenAiChoice();
      candidate = {
        workspaceId: INSTALLATION_ENDPOINT_ID,
        preference: "openai",
        provider: "openai-secure",
        tunnelId,
        askedAt: new Date().toISOString(),
        configuredAt: new Date().toISOString(),
      };
    } else if (mode === "pairing") {
      const transport = opts.transport ?? "quick";
      if (transport === "quick") {
        if (opts.zone || opts.hostname) throw new Error("--zone and --hostname require --transport named.");
        candidate = chooseQuickTunnel(INSTALLATION_ENDPOINT_ID, undefined, false);
      } else if (transport === "named") {
        const zone = parseZoneInput(opts.zone ?? "");
        if (!zone) throw new Error("NEED_CLOUDFLARE_ZONE: pass --zone with a domain managed by Cloudflare (e.g. example.com).");
        if (!opts.json) say(namedLoginPrompt());
        const result = await provisionNamedTunnel({
          workspaceId: INSTALLATION_ENDPOINT_ID,
          workspaceName: PRODUCT_NAME,
          zone,
          hostname: opts.hostname,
          persist: false,
        });
        // A failed named choice must not replace a working profile with a quick tunnel.
        if (result.fallback) throw new Error(`NAMED_TUNNEL_PROVISION_FAILED: ${result.error ?? "configuration failed"}`);
        candidate = result.state;
      } else {
        throw new Error("transport must be quick or named");
      }
    } else {
      throw new Error("connection mode must be secure or pairing");
    }
    const state = await commitTunnelChoice(candidate);
    if (opts.json) say(JSON.stringify({ ...connectionPayload(), state }));
    else {
      check(t(`Connection profile saved: ${mode}`, `連線設定檔已儲存：${mode}`));
      say(t("Run c2c start to establish the connection. Changing profiles may require updating the ChatGPT connector.", "請執行 c2c start 建立連線。切換設定檔後，可能需要更新 ChatGPT 連接器。"));
    }
  } catch (error) {
    handleCliError(error, opts.json);
  }
}

connection.command("use")
  .description("Select Secure Tunnel (recommended) or explicitly opt in to Pairing")
  .argument("<mode>", "secure or pairing")
  .option("--transport <provider>", "Pairing only: quick (default) or named")
  .option("--zone <domain>", "Cloudflare domain for a named hostname")
  .option("--hostname <hostname>", "override the installation's named hostname")
  .option("--json", "machine-readable output", false)
  .action(useConnection);

acceptUnusedWorkspaceOption(
  tunnelCmd.command("choose")
    .description("Legacy spelling: openai = secure; quick/named = pairing")
    .requiredOption("--mode <mode>", "quick, named, or openai")
    .option("--zone <domain>", "Cloudflare domain for a named hostname")
    .option("--hostname <hostname>", "override the installation's named hostname")
    .option("--json", "machine-readable output", false)
).action(async (opts: ConnectionChoiceOptions & { mode: string }) => {
  const mode = opts.mode.trim().toLowerCase();
  if (!["openai", "quick", "named"].includes(mode)) {
    handleCliError(new Error("mode must be quick, named, or openai"), opts.json);
    return;
  }
  await useConnection(mode === "openai" ? "secure" : "pairing", {
    ...opts,
    transport: mode === "openai" ? undefined : mode,
  });
});

function handleCliError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    say(JSON.stringify({ ok: false, error: message }));
  } else if (message.startsWith("NEED_CLOUDFLARED")) {
    say(t("cloudflared is required for Pairing mode.", "Pairing 模式需要 cloudflared。"));
    say(t("On macOS: brew install cloudflared", "macOS：brew install cloudflared"));
    say(t("Install it, then retry.", "安裝後請重試。"));
  } else {
    cross(message);
  }
  process.exitCode = 1;
}

localizeHelp(program);
program.parseAsync(process.argv).catch((error: Error) => {
  cross(error.message);
  process.exit(1);
});
