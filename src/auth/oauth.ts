import { Router, type Request, type Response, urlencoded, json } from "express";
import { randomBytes } from "node:crypto";
import { AuthStore, SUPPORTED_SCOPES, base64UrlSha256, filterScopes, safeEqual } from "./store.js";
import { PairingManager } from "../pairing/manager.js";
import type { Logger } from "../logger/index.js";
import { PRODUCT_NAME } from "../version.js";
import { escapeHtml, setAuthSecurityHeaders } from "./html.js";
import { readLanguage, t } from "../config/language.js";

export interface OAuthDeps {
  store: AuthStore;
  pairing: PairingManager;
  workspaceName: string;
  getBaseUrl: (req: Request) => string;
  /** Override when the external MCP URL is already path-qualified (OpenAI tunnel). */
  getResourceUrl?: (req: Request, base: string) => string;
  logger: Logger;
}

interface PendingAuthRequest {
  id: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state?: string;
  codeChallenge: string;
  resource?: string;
  expiresAt: number;
}

function isAllowedRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) {
    return true;
  }
  return false;
}

function authorizationServerMetadata(base: string): Record<string, unknown> {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...SUPPORTED_SCOPES],
  };
}

function protectedResourceMetadata(base: string, resource = `${base}/mcp`): Record<string, unknown> {
  return {
    resource,
    authorization_servers: [base],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: PRODUCT_NAME,
  };
}

function pairingPage(opts: {
  requestId: string;
  workspaceName: string;
  scopes: string[];
  error?: string;
}): string {
  const scopeLabels: Record<string, string> = {
    "workspace.read": t("Read files in registered workspaces", "讀取已註冊工作區的檔案"),
    "workspace.search": t("Search registered workspaces", "搜尋已註冊工作區"),
    "git.read": t("Read git status and diffs", "讀取 git 狀態與差異"),
    "execution.read": t("Read Codex execution summaries", "讀取 Codex 執行摘要"),
    offline_access: t("Stay connected between sessions", "在不同對話之間保持授權"),
  };
  const scopeList = opts.scopes
    .map((scope) => `<li>${escapeHtml(scopeLabels[scope] ?? scope)}</li>`)
    .join("");
  const errorHtml = opts.error
    ? `<p class="error" role="alert">${escapeHtml(opts.error)}</p>`
    : "";
  const escapedProductName = escapeHtml(PRODUCT_NAME);
  const escapedWorkspaceName = escapeHtml(opts.workspaceName);
  const escapedRequestId = escapeHtml(opts.requestId);
  return `<!doctype html>
<html lang="${readLanguage()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapedProductName}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         display: flex; align-items: center; justify-content: center; min-height: 100vh;
         margin: 0; background: #f5f5f7; color: #1d1d1f; }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } .card { background: #1c1c1e !important; } }
  .card { background: #fff; border-radius: 16px; padding: 40px; max-width: 420px; width: 90%;
          box-shadow: 0 4px 24px rgba(0,0,0,.08); }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #86868b; font-size: 14px; margin: 0 0 20px; }
  ul { font-size: 13px; color: #6e6e73; padding-left: 18px; margin: 0 0 24px; }
  li { margin-bottom: 4px; }
  label { display: block; margin-bottom: 8px; font-size: 14px; }
  input[type=text] { width: 100%; box-sizing: border-box; font-size: 24px; letter-spacing: 4px;
          text-align: center; text-transform: uppercase; padding: 12px; border: 1.5px solid #d2d2d7;
          border-radius: 10px; font-family: ui-monospace, monospace; background: transparent; color: inherit; }
  input[type=text]:focus { outline: none; border-color: #0071e3; }
  button { width: 100%; margin-top: 16px; padding: 12px; font-size: 16px; border: 0; border-radius: 10px;
           background: #0071e3; color: #fff; cursor: pointer; }
  button:hover { background: #0077ed; }
  .error { color: #d70015; font-size: 13px; margin: 12px 0 0; }
  .hint { color: #86868b; font-size: 12px; margin-top: 16px; text-align: center; }
</style>
</head>
<body>
<div class="card">
  <h1>${escapedProductName}</h1>
  <p class="sub">${t("ChatGPT is requesting read-only access to", "ChatGPT 正在要求唯讀存取權：")} <strong>${escapedWorkspaceName}</strong>:</p>
  <ul>${scopeList}</ul>
  <form method="POST" action="authorize">
    <input type="hidden" name="request_id" value="${escapedRequestId}">
    <label for="pairing_code">${t("Pairing code", "配對碼")}</label>
    <input type="text" name="pairing_code" id="pairing_code" placeholder="XXXX-XXXX"
           autocomplete="one-time-code" autofocus maxlength="9" required>
    ${errorHtml}
    <button type="submit">${t("Connect", "連線")}</button>
  </form>
  <p class="hint">${t("Run c2c pair on this computer to generate a code.", "請在此電腦執行 c2c pair 產生配對碼。")}<br>${t("It expires in five minutes and can be used once.", "五分鐘內有效，僅限使用一次。")}</p>
</div>
</body>
</html>`;
}

export function createOAuthRouter(deps: OAuthDeps): Router {
  const router = Router();
  const pendingRequests = new Map<string, PendingAuthRequest>();

  const prunePending = (): void => {
    const now = Date.now();
    for (const [id, request] of pendingRequests) {
      if (now > request.expiresAt) pendingRequests.delete(id);
    }
  };

  // ---- Discovery metadata -------------------------------------------------

  const asMetadataHandler = (req: Request, res: Response): void => {
    res.json(authorizationServerMetadata(deps.getBaseUrl(req)));
  };
  const prMetadataHandler = (req: Request, res: Response): void => {
    const base = deps.getBaseUrl(req);
    res.json(protectedResourceMetadata(base, deps.getResourceUrl?.(req, base)));
  };
  router.get("/.well-known/oauth-authorization-server", asMetadataHandler);
  router.get("/.well-known/oauth-authorization-server/mcp", asMetadataHandler);
  router.get("/.well-known/openid-configuration", asMetadataHandler);
  router.get("/.well-known/oauth-protected-resource", prMetadataHandler);
  router.get("/.well-known/oauth-protected-resource/mcp", prMetadataHandler);

  // ---- Dynamic Client Registration (RFC 7591) ------------------------------

  router.post("/oauth/register", json(), (req, res) => {
    const body = req.body as { client_name?: string; redirect_uris?: unknown };
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (
      redirectUris.length === 0 ||
      !redirectUris.every((uri) => typeof uri === "string" && isAllowedRedirectUri(uri))
    ) {
      res.status(400).json({
        error: "invalid_redirect_uri",
        error_description: "redirect_uris must be https URLs (or http://localhost for development)",
      });
      return;
    }
    const client = deps.store.registerClient({
      clientName: typeof body.client_name === "string" ? body.client_name.slice(0, 200) : undefined,
      redirectUris: redirectUris as string[],
    });
    deps.logger.info(`Registered OAuth client ${client.clientId} (${client.clientName ?? "unnamed"})`);
    res.status(201).json({
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  // ---- Authorization endpoint ----------------------------------------------

  router.get("/oauth/authorize", (req, res) => {
    prunePending();
    const query = req.query as Record<string, string | undefined>;
    const client = query.client_id ? deps.store.getClient(query.client_id) : undefined;
    if (!client) {
      setAuthSecurityHeaders(res);
      res.status(400).send(t("Unknown client. Please reconnect from ChatGPT.", "未知的用戶端。請從 ChatGPT 重新連線。"));
      return;
    }
    const redirectUri = query.redirect_uri;
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      setAuthSecurityHeaders(res);
      res.status(400).send(t("Invalid redirect_uri.", "無效的 redirect_uri。"));
      return;
    }
    const fail = (error: string, description: string): void => {
      const url = new URL(redirectUri);
      url.searchParams.set("error", error);
      url.searchParams.set("error_description", description);
      if (query.state) url.searchParams.set("state", query.state);
      res.redirect(url.toString());
    };
    if (query.response_type !== "code") {
      fail("unsupported_response_type", "Only response_type=code is supported");
      return;
    }
    if (!query.code_challenge || query.code_challenge_method !== "S256") {
      fail("invalid_request", "PKCE with S256 is required");
      return;
    }
    const scopes = filterScopes(query.scope);
    const request: PendingAuthRequest = {
      id: randomBytes(16).toString("hex"),
      clientId: client.clientId,
      redirectUri,
      scopes,
      state: query.state,
      codeChallenge: query.code_challenge,
      resource: query.resource,
      expiresAt: Date.now() + 10 * 60_000,
    };
    pendingRequests.set(request.id, request);
    setAuthSecurityHeaders(res);
    res
      .status(200)
      .type("html")
      .send(pairingPage({ requestId: request.id, workspaceName: deps.workspaceName, scopes }));
  });

  router.post("/oauth/authorize", urlencoded({ extended: false }), (req, res) => {
    prunePending();
    const body = req.body as { request_id?: string; pairing_code?: string };
    const request = body.request_id ? pendingRequests.get(body.request_id) : undefined;
    if (!request) {
      setAuthSecurityHeaders(res);
      res.status(400).send(t("This authorization request has expired. Please reconnect from ChatGPT.", "此授權請求已過期。請從 ChatGPT 重新連線。"));
      return;
    }
    const verdict = deps.pairing.verify(body.pairing_code ?? "", req.ip);
    if (!verdict.ok) {
      const messages: Record<string, string> = {
        invalid: t(`Incorrect pairing code.${verdict.attemptsLeft !== undefined ? ` ${verdict.attemptsLeft} attempts left.` : ""}`, `配對碼不正確。${verdict.attemptsLeft !== undefined ? `剩餘 ${verdict.attemptsLeft} 次嘗試。` : ""}`),
        expired: t("This pairing code has expired. Run c2c pair to generate a new one.", "配對碼已過期。請執行 c2c pair 產生新碼。"),
        too_many_attempts: t("Too many incorrect attempts. Run c2c pair to generate a new code.", "錯誤嘗試次數過多。請執行 c2c pair 產生新碼。"),
        rate_limited: t("Too many attempts. Please wait a minute and try again.", "嘗試次數過多。請稍候一分鐘再重試。"),
        no_active_session: t("No active pairing session. Run c2c pair to generate a code.", "沒有進行中的配對。請執行 c2c pair 產生配對碼。"),
      };
      deps.logger.warn(`Pairing verification failed: ${verdict.reason}`);
      setAuthSecurityHeaders(res);
      res
        .status(verdict.reason === "invalid" ? 401 : 410)
        .type("html")
        .send(
          pairingPage({
            requestId: request.id,
            workspaceName: deps.workspaceName,
            scopes: request.scopes,
            error: messages[verdict.reason] ?? t("Verification failed.", "驗證失敗。"),
          })
        );
      return;
    }
    pendingRequests.delete(request.id);
    const code = deps.store.createAuthorizationCode({
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      scopes: request.scopes,
      pairingSessionId: verdict.sessionId,
      resource: request.resource,
    });
    deps.logger.info(`Pairing verified; issued authorization code for client ${request.clientId}`);
    const url = new URL(request.redirectUri);
    url.searchParams.set("code", code);
    if (request.state) url.searchParams.set("state", request.state);
    res.redirect(url.toString());
  });

  // ---- Token endpoint --------------------------------------------------------

  router.post("/oauth/token", urlencoded({ extended: false }), json(), (req, res) => {
    const body = req.body as Record<string, string | undefined>;
    const grantType = body.grant_type;

    if (grantType === "authorization_code") {
      const { code, code_verifier: codeVerifier, client_id: clientId, redirect_uri: redirectUri } = body;
      if (!code || !codeVerifier || !clientId) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      const record = deps.store.consumeAuthorizationCode(code);
      if (!record || record.clientId !== clientId) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      if (redirectUri && redirectUri !== record.redirectUri) {
        res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
        return;
      }
      if (!safeEqual(base64UrlSha256(codeVerifier), record.codeChallenge)) {
        deps.logger.warn("PKCE verification failed at token endpoint");
        res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
        return;
      }
      const tokens = deps.store.issueTokens({
        clientId,
        scopes: record.scopes,
      });
      deps.logger.info(`Issued access token for client ${clientId}`);
      res.json({
        access_token: tokens.accessToken,
        token_type: "Bearer",
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken ?? undefined,
        scope: tokens.scopes.join(" "),
      });
      return;
    }

    if (grantType === "refresh_token") {
      const { refresh_token: refreshToken, client_id: clientId } = body;
      if (!refreshToken || !clientId) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      const result = deps.store.refresh(refreshToken, clientId);
      if (!result.ok) {
        res.status(400).json({ error: result.reason });
        return;
      }
      res.json({
        access_token: result.tokens.accessToken,
        token_type: "Bearer",
        expires_in: result.tokens.expiresIn,
        refresh_token: result.tokens.refreshToken ?? undefined,
        scope: result.tokens.scopes.join(" "),
      });
      return;
    }

    res.status(400).json({ error: "unsupported_grant_type" });
  });

  // ---- Revocation (RFC 7009) ---------------------------------------------------

  router.post("/oauth/revoke", urlencoded({ extended: false }), (req, res) => {
    const body = req.body as { token?: string };
    if (body.token) deps.store.revokeToken(body.token);
    res.status(200).json({});
  });

  return router;
}
