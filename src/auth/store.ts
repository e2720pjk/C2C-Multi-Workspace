import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, readJsonStrict, writeSecureJson } from "../config/paths.js";

export const SUPPORTED_SCOPES = [
  "workspace.read",
  "workspace.search",
  "git.read",
  "execution.read",
  "offline_access",
] as const;

export type Scope = (typeof SUPPORTED_SCOPES)[number];

export interface ClientRegistration {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  createdAt: string;
}

export interface AuthorizationCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  workspaceId: string;
  pairingSessionId: string;
  resource?: string;
  expiresAt: number;
}

export interface TokenRecord {
  hash: string;
  kind: "access" | "refresh";
  clientId: string;
  workspaceId: string;
  scopes: string[];
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
}

/** Process-scoped credential used only by the installation-owned tunnel child. */
export interface InternalTokenRecord {
  hash: string;
  kind: "internal";
  clientId: string;
  workspaceId: string;
  scopes: string[];
  issuedAt: number;
  expiresAt?: never;
}

interface PersistedAuthState {
  clients: ClientRegistration[];
  tokens: TokenRecord[];
}

export type VerifyTokenResult =
  | { ok: true; record: TokenRecord | InternalTokenRecord }
  | { ok: false; reason: "unknown" | "expired" | "revoked" | "wrong_kind" };

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;

function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function base64UrlSha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** Constant-time string comparison for equal-length inputs. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class AuthStore {
  private clients = new Map<string, ClientRegistration>();
  private tokens = new Map<string, TokenRecord>();
  private internalTokens = new Map<string, InternalTokenRecord>();
  private authCodes = new Map<string, AuthorizationCodeRecord>();
  private readonly file: string;

  constructor(
    readonly workspaceId: string,
    opts: { file?: string } = {}
  ) {
    this.file =
      opts.file ?? path.join(ensureDir(path.join(getStateDir(), "auth")), `${workspaceId}.json`);
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.file)) return;
    let data: unknown;
    try {
      data = readJsonStrict<unknown>(this.file);
    } catch {
      throw new Error("Canonical OAuth state is corrupt; refusing to start with a new token store.");
    }
    if (data === null) {
      throw new Error("Canonical OAuth state is empty; refusing to start with a new token store.");
    }
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      !Array.isArray((data as Partial<PersistedAuthState>).clients) ||
      !Array.isArray((data as Partial<PersistedAuthState>).tokens)
    ) {
      throw new Error("Canonical OAuth state is invalid; refusing to start with a new token store.");
    }
    const state = data as PersistedAuthState;
    const now = Date.now();
    for (const client of state.clients) {
      if (
        !client ||
        typeof client.clientId !== "string" ||
        (client.clientName !== undefined && typeof client.clientName !== "string") ||
        !Array.isArray(client.redirectUris) ||
        client.redirectUris.some((uri) => typeof uri !== "string") ||
        typeof client.createdAt !== "string"
      ) {
        throw new Error("Canonical OAuth client state is invalid; refusing to start.");
      }
      this.clients.set(client.clientId, client);
    }
    for (const token of state.tokens) {
      if (
        !token ||
        typeof token.hash !== "string" ||
        (token.kind !== "access" && token.kind !== "refresh") ||
        typeof token.clientId !== "string" ||
        typeof token.workspaceId !== "string" ||
        !Array.isArray(token.scopes) ||
        token.scopes.some((scope) => typeof scope !== "string") ||
        typeof token.issuedAt !== "number" ||
        typeof token.expiresAt !== "number" ||
        typeof token.revoked !== "boolean"
      ) {
        throw new Error("Canonical OAuth token state is invalid; refusing to start.");
      }
      if (!token.revoked && token.expiresAt > now) this.tokens.set(token.hash, token);
    }
  }

  private save(): void {
    const now = Date.now();
    const state: PersistedAuthState = {
      clients: [...this.clients.values()],
      tokens: [...this.tokens.values()].filter((t) => !t.revoked && t.expiresAt > now),
    };
    writeSecureJson(this.file, state);
  }

  // ---- Dynamic Client Registration -------------------------------------

  registerClient(input: { clientName?: string; redirectUris: string[] }): ClientRegistration {
    const client: ClientRegistration = {
      clientId: `c2c_client_${randomBytes(12).toString("base64url")}`,
      clientName: input.clientName,
      redirectUris: input.redirectUris,
      createdAt: new Date().toISOString(),
    };
    this.clients.set(client.clientId, client);
    this.save();
    return client;
  }

  getClient(clientId: string): ClientRegistration | undefined {
    return this.clients.get(clientId);
  }

  // ---- Authorization codes ----------------------------------------------

  createAuthorizationCode(input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scopes: string[];
    pairingSessionId: string;
    resource?: string;
  }): string {
    const code = newToken("c2c_ac");
    this.authCodes.set(code, {
      code,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scopes: input.scopes,
      workspaceId: this.workspaceId,
      pairingSessionId: input.pairingSessionId,
      resource: input.resource,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });
    return code;
  }

  /** One-time consumption of an authorization code. */
  consumeAuthorizationCode(code: string): AuthorizationCodeRecord | null {
    const record = this.authCodes.get(code);
    if (!record) return null;
    this.authCodes.delete(code);
    if (Date.now() > record.expiresAt) return null;
    return record;
  }

  // ---- Tokens -------------------------------------------------------------

  issueTokens(input: {
    clientId: string;
    scopes: string[];
    workspaceId?: string;
    accessTtlMs?: number;
  }): { accessToken: string; refreshToken: string | null; expiresIn: number; scopes: string[] } {
    const now = Date.now();
    const workspaceId = input.workspaceId ?? this.workspaceId;
    const accessTtl = input.accessTtlMs ?? ACCESS_TOKEN_TTL_MS;

    const accessToken = newToken("c2c_at");
    this.tokens.set(sha256hex(accessToken), {
      hash: sha256hex(accessToken),
      kind: "access",
      clientId: input.clientId,
      workspaceId,
      scopes: input.scopes,
      issuedAt: now,
      expiresAt: now + accessTtl,
      revoked: false,
    });

    let refreshToken: string | null = null;
    if (input.scopes.includes("offline_access")) {
      refreshToken = newToken("c2c_rt");
      this.tokens.set(sha256hex(refreshToken), {
        hash: sha256hex(refreshToken),
        kind: "refresh",
        clientId: input.clientId,
        workspaceId,
        scopes: input.scopes,
        issuedAt: now,
        expiresAt: now + REFRESH_TOKEN_TTL_MS,
        revoked: false,
      });
    }
    this.save();
    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(accessTtl / 1000),
      scopes: input.scopes,
    };
  }

  /**
   * Issue an installation-owned tunnel credential without persisting it.
   * Its lifetime is the owning Bridge process, not an arbitrary token TTL.
   */
  issueInternalToken(input: {
    clientId: string;
    scopes: string[];
    workspaceId?: string;
  }): string {
    const token = newToken("c2c_it");
    const hash = sha256hex(token);
    this.internalTokens.set(hash, {
      hash,
      kind: "internal",
      clientId: input.clientId,
      workspaceId: input.workspaceId ?? this.workspaceId,
      scopes: input.scopes,
      issuedAt: Date.now(),
    });
    return token;
  }

  verifyAccessToken(token: string): VerifyTokenResult {
    const hash = sha256hex(token);
    const internal = this.internalTokens.get(hash);
    if (internal) return { ok: true, record: internal };
    const record = this.tokens.get(hash);
    if (!record) return { ok: false, reason: "unknown" };
    if (record.kind !== "access") return { ok: false, reason: "wrong_kind" };
    if (record.revoked) return { ok: false, reason: "revoked" };
    if (Date.now() > record.expiresAt) return { ok: false, reason: "expired" };
    return { ok: true, record };
  }

  /** Refresh-token rotation: old refresh token is revoked, a new pair is issued. */
  refresh(
    refreshToken: string,
    clientId: string
  ): { ok: true; tokens: ReturnType<AuthStore["issueTokens"]> } | { ok: false; reason: string } {
    const record = this.tokens.get(sha256hex(refreshToken));
    if (!record || record.kind !== "refresh") return { ok: false, reason: "invalid_grant" };
    if (record.revoked) return { ok: false, reason: "invalid_grant" };
    if (Date.now() > record.expiresAt) return { ok: false, reason: "invalid_grant" };
    if (record.clientId !== clientId) return { ok: false, reason: "invalid_client" };
    record.revoked = true;
    this.tokens.delete(record.hash);
    const tokens = this.issueTokens({
      clientId,
      scopes: record.scopes,
      workspaceId: record.workspaceId,
    });
    return { ok: true, tokens };
  }

  revokeToken(token: string): boolean {
    const hash = sha256hex(token);
    if (this.internalTokens.delete(hash)) return true;
    const record = this.tokens.get(hash);
    if (!record) return false;
    record.revoked = true;
    this.tokens.delete(record.hash);
    this.save();
    return true;
  }

  /** Remove legacy persisted tunnel credentials and any live internal credentials. */
  revokeClientTokens(clientId: string): number {
    let count = 0;
    for (const [hash, token] of this.internalTokens) {
      if (token.clientId !== clientId) continue;
      this.internalTokens.delete(hash);
      count++;
    }
    for (const [hash, token] of this.tokens) {
      if (token.clientId !== clientId) continue;
      token.revoked = true;
      this.tokens.delete(hash);
      count++;
    }
    if (count > 0) this.save();
    return count;
  }

  /** Used by `c2c unpair`: revoke everything for this workspace. */
  revokeAll(): number {
    const count = this.tokens.size + this.internalTokens.size;
    this.tokens.clear();
    this.internalTokens.clear();
    this.authCodes.clear();
    this.save();
    return count;
  }

  tokenCount(): number {
    return this.tokens.size + this.internalTokens.size;
  }

  static deleteStateFile(workspaceId: string): void {
    const file = path.join(getStateDir(), "auth", `${workspaceId}.json`);
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }
}

export function filterScopes(requested: string | undefined): string[] {
  if (!requested || requested.trim() === "") return [...SUPPORTED_SCOPES];
  const asked = requested.split(/[\s+]+/).filter(Boolean);
  const granted = asked.filter((scope) => (SUPPORTED_SCOPES as readonly string[]).includes(scope));
  return granted.length > 0 ? granted : [...SUPPORTED_SCOPES];
}
