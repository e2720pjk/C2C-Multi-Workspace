import fs from "node:fs";
import path from "node:path";
import { acquireStateLock } from "../config/lock.js";
import { getStateDir, readJsonStrict, writeSecureJson } from "../config/paths.js";
import { t } from "../config/language.js";

export type TunnelPreference = "unset" | "quick" | "named" | "openai";
export type TunnelProviderName = "cloudflare-quick" | "cloudflare-named" | "openai-secure";
export type ConnectionMode = "secure" | "pairing";

/** Preserve explicit legacy choices; an unconfigured installation defaults to Secure Tunnel. */
export function connectionMode(state: TunnelState): ConnectionMode {
  return state.preference === "quick" || state.preference === "named" ? "pairing" : "secure";
}

/** The only tunnel state owned by the current installation contract. */
export const CANONICAL_TUNNEL_STATE_ID = "installation";
const OPENAI_TUNNEL_ID_RE = /^tunnel_[a-f0-9]{32}$/;

export interface TunnelState {
  /** Always CANONICAL_TUNNEL_STATE_ID when persisted or returned. */
  workspaceId: string;
  preference: TunnelPreference;
  askedAt?: string;
  provider?: TunnelProviderName;
  tunnelName?: string;
  tunnelId?: string;
  hostname?: string;
  zone?: string;
  configuredAt?: string;
  fallbackReason?: string;
}

export interface OpenAiRuntimeConfiguration {
  tunnelId: string | null;
  apiKeyPresent: boolean;
  complete: boolean;
  missing: string[];
  invalidTunnelId: boolean;
}

export interface TunnelSelection {
  provider: TunnelProviderName;
  diagnostic?: string;
}

/** Path for the one canonical installation-owned tunnel record. */
export function tunnelStateFile(_workspaceId = CANONICAL_TUNNEL_STATE_ID): string {
  return path.join(getStateDir(), "tunnels", `${CANONICAL_TUNNEL_STATE_ID}.json`);
}

/** Used only by diagnostics/tests to identify obsolete per-workspace files. */
export function obsoleteTunnelStateFile(workspaceId: string): string {
  return path.join(getStateDir(), "tunnels", `${workspaceId}.json`);
}

function emptyState(): TunnelState {
  return { workspaceId: CANONICAL_TUNNEL_STATE_ID, preference: "unset" };
}

function validateState(value: unknown): TunnelState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Canonical tunnel state is invalid; refusing to start or replace a tunnel.");
  }
  const state = value as Partial<TunnelState> & { schemaVersion?: unknown };
  if (state.schemaVersion !== undefined && state.schemaVersion !== 1) {
    throw new Error(`Canonical tunnel state schema ${String(state.schemaVersion)} is unsupported; reset local C2C state.`);
  }
  const stringFields = [
    "workspaceId",
    "preference",
    "askedAt",
    "provider",
    "tunnelName",
    "tunnelId",
    "hostname",
    "zone",
    "configuredAt",
    "fallbackReason",
  ] as const;
  if (
    state.workspaceId !== CANONICAL_TUNNEL_STATE_ID ||
    !["unset", "quick", "named", "openai"].includes(state.preference ?? "") ||
    stringFields.some((field) => state[field] !== undefined && typeof state[field] !== "string") ||
    (state.provider !== undefined && !["cloudflare-quick", "cloudflare-named", "openai-secure"].includes(state.provider))
  ) {
    throw new Error("Canonical tunnel state is invalid; refusing to start or replace a tunnel.");
  }
  const expectedProvider: TunnelProviderName | undefined =
    state.preference === "quick"
      ? "cloudflare-quick"
      : state.preference === "named"
        ? "cloudflare-named"
        : state.preference === "openai"
          ? "openai-secure"
          : undefined;
  if (state.provider !== undefined && state.provider !== expectedProvider) {
    throw new Error("Canonical tunnel state is ambiguous; preference and provider disagree.");
  }
  if (state.preference === "unset" && state.tunnelId !== undefined) {
    throw new Error("Canonical tunnel state is ambiguous; an unset preference has a Tunnel ID.");
  }
  if (state.preference === "quick" && state.tunnelId !== undefined) {
    throw new Error("Canonical tunnel state is ambiguous; a quick tunnel has a Tunnel ID.");
  }
  if (state.preference !== "named" && [state.tunnelName, state.hostname, state.zone].some((value) => value !== undefined)) {
    throw new Error("Canonical tunnel state is ambiguous; named-tunnel fields require the named preference.");
  }
  if (state.preference === "openai" && state.tunnelId !== undefined && !OPENAI_TUNNEL_ID_RE.test(state.tunnelId)) {
    throw new Error("Canonical OpenAI tunnel state has an invalid Tunnel ID; reset local C2C state.");
  }
  return { ...state, workspaceId: CANONICAL_TUNNEL_STATE_ID } as TunnelState;
}

/** Read only the installation-owned record; per-workspace files are ignored. */
export function readTunnelState(_workspaceId = CANONICAL_TUNNEL_STATE_ID): TunnelState {
  const file = tunnelStateFile();
  if (!fs.existsSync(file)) return emptyState();
  let value: unknown;
  try {
    value = readJsonStrict<unknown>(file);
  } catch {
    throw new Error("Canonical tunnel state is corrupt; refusing to start or replace a tunnel.");
  }
  return validateState(value);
}

/** Kept as a source-compatible call shape; the argument no longer selects state. */
export function readInstallationTunnelState(_defaultWorkspaceId?: string): TunnelState {
  return readTunnelState();
}

export function openAiRuntimeConfiguration(
  env: NodeJS.ProcessEnv = process.env,
  persistedTunnelId?: string
): OpenAiRuntimeConfiguration {
  const rawTunnelId = (persistedTunnelId?.trim() || env.CONTROL_PLANE_TUNNEL_ID?.trim() || "");
  const tunnelId = rawTunnelId || null;
  const apiKeyPresent = Boolean(env.CONTROL_PLANE_API_KEY?.trim());
  const invalidTunnelId = tunnelId !== null && !OPENAI_TUNNEL_ID_RE.test(tunnelId);
  const missing: string[] = [];
  if (!tunnelId) missing.push("CONTROL_PLANE_TUNNEL_ID");
  else if (invalidTunnelId) missing.push("valid CONTROL_PLANE_TUNNEL_ID");
  if (!apiKeyPresent) missing.push("CONTROL_PLANE_API_KEY");
  return {
    tunnelId: invalidTunnelId ? null : tunnelId,
    apiKeyPresent,
    complete: missing.length === 0,
    missing,
    invalidTunnelId,
  };
}

/** Resolve provider precedence without ever using a partial OpenAI request. */
export function selectTunnelProvider(
  state: TunnelState,
  env: NodeJS.ProcessEnv = process.env
): TunnelSelection {
  const canonical = validateState(state);
  if (connectionMode(canonical) === "secure") {
    const config = openAiRuntimeConfiguration(env, canonical.tunnelId);
    return {
      provider: "openai-secure",
      diagnostic: config.complete
        ? undefined
        : `INCOMPLETE_OPENAI_CONFIGURATION: missing ${config.missing.join(" and ")}`,
    };
  }
  if (canonical.preference === "named") {
    return {
      provider: "cloudflare-named",
      diagnostic: isNamedTunnelReady(canonical)
        ? undefined
        : "CONFIGURED_PROVIDER_UNAVAILABLE: persisted named tunnel state is incomplete",
    };
  }
  if (canonical.preference === "quick") return { provider: "cloudflare-quick" };

  throw new Error("Unsupported connection configuration.");
}

export function writeTunnelState(state: TunnelState): TunnelState {
  const canonical = validateState({ ...state, workspaceId: CANONICAL_TUNNEL_STATE_ID });
  const lock = acquireStateLock(path.join(getStateDir(), "runtime", "tunnel-state.lock"));
  try {
    writeSecureJson(tunnelStateFile(), canonical);
    return canonical;
  } finally {
    lock.release();
  }
}

export function needsTunnelChoice(state: TunnelState): boolean {
  return connectionMode(state) === "pairing" && !state.askedAt;
}

export function isNamedTunnelReady(state: TunnelState): boolean {
  return (
    state.preference === "named" &&
    Boolean(state.tunnelName?.trim()) &&
    Boolean(state.hostname?.trim())
  );
}

export function namedTunnelBinding(state: TunnelState): { tunnelName: string; hostname: string } | null {
  if (!isNamedTunnelReady(state) || !state.tunnelName || !state.hostname) return null;
  return { tunnelName: state.tunnelName, hostname: state.hostname };
}

export function namedLoginPrompt(): string {
  return t("Sign in to Cloudflare in the browser and select your domain.", "請在瀏覽器登入 Cloudflare 並選擇你的網域。");
}

export function namedFallbackMessage(): string {
  return t("Named tunnel provisioning failed; the candidate uses a temporary address.", "固定網域設定失敗；候選設定使用臨時位址。");
}

export function namedRepairMessage(): string {
  return t("The named tunnel is unavailable. Run c2c connection login and select your domain.", "固定網域連線無法使用。請執行 c2c connection login 並選擇你的網域。");
}
