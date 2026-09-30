import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "./paths.js";
import { t } from "./language.js";

export const CHATGPT_DEVELOPER_MODE_URL = "https://chatgpt.com/#settings/Security";
export const CHATGPT_PLUGINS_URL = "https://chatgpt.com/plugins";
export const CHATGPT_CREATE_CONNECTOR_URL =
  "https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins";

export const DEFAULT_CONNECTOR_NAME = "Codex with ChatGPT";

export interface LastEndpoint {
  workspaceId: string;
  port: number;
  publicUrl: string | null;
  mcpUrl: string | null;
  connectorName?: string;
  savedAt: string;
}

export function endpointFile(workspaceId: string): string {
  return path.join(getStateDir(), "endpoints", `${workspaceId}.json`);
}

export function readLastEndpoint(workspaceId: string): LastEndpoint | null {
  return readJsonIfExists<LastEndpoint>(endpointFile(workspaceId));
}

export function writeLastEndpoint(endpoint: Omit<LastEndpoint, "savedAt">): LastEndpoint {
  const saved: LastEndpoint = { ...endpoint, savedAt: new Date().toISOString() };
  writeSecureJson(endpointFile(saved.workspaceId), saved);
  return saved;
}

export function normalizePublicUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

export function mcpUrlFromPublic(publicUrl: string | null | undefined): string | null {
  if (!publicUrl) return null;
  const base = normalizePublicUrl(publicUrl).replace(/\/mcp$/, "");
  return `${base}/mcp`;
}

/** What the Skill should do to THIS workspace's ChatGPT connector.
 *  `update` means the public address changed: Delete the old connector
 *  in ChatGPT, then create it again. Never click Reconnect (the old
 *  URL is dead and hangs on "This site cannot be reached"). */
export function connectorAction(
  previousMcpUrl: string | null | undefined,
  nextMcpUrl: string | null | undefined
): "none" | "create" | "update" {
  if (!nextMcpUrl) return "none";
  if (!previousMcpUrl) return "create";
  return normalizePublicUrl(previousMcpUrl) === normalizePublicUrl(nextMcpUrl) ? "none" : "update";
}

export function sanitizeConnectorLabel(name: string, workspaceId: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N}._\- ]+/gu, "").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 40) || workspaceId.slice(0, 6);
}

/**
 * Same workspace keeps one connector title forever.
 * A workspace already recorded without a title stays on the original
 * "Codex with ChatGPT" name. A new workspace gets a distinct title.
 */
export function connectorNameFor(opts: {
  workspaceName: string;
  workspaceId: string;
  previousName?: string | null;
  hadEndpointBefore: boolean;
}): string {
  if (opts.previousName?.trim()) return opts.previousName.trim();
  if (opts.hadEndpointBefore) return DEFAULT_CONNECTOR_NAME;
  return `${DEFAULT_CONNECTOR_NAME} · ${sanitizeConnectorLabel(opts.workspaceName, opts.workspaceId)}`;
}

export function reclaimUserMessage(connectorName: string): string {
  return t(
    `The installation's connection address changed. Replace the ChatGPT connector "${connectorName}" using the new address. This connector serves all registered workspaces.`,
    `此安裝的連線位址已變更。請使用新位址重新建立 ChatGPT 連接器「${connectorName}」。此連接器供所有已註冊的工作區共用。`
  );
}
