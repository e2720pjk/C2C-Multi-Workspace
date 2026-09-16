import type { NextFunction, Request, Response } from "express";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { safeEqual, type AuthStore } from "./store.js";
import type { Logger } from "../logger/index.js";

export interface InternalBearer {
  token: string;
  clientId: string;
  scopes: string[];
}

export interface BearerAuthDeps {
  store: AuthStore;
  /** Legacy single-workspace audience check. Omit for installation tokens. */
  workspaceId?: string;
  /** Installation-owned bearer used only by the loopback tunnel-client binding. */
  internalBearer?: InternalBearer;
  getBaseUrl: (req: Request) => string;
  logger: Logger;
}

/**
 * Bearer-token guard for /mcp.
 * - the installation-owned tunnel bearer is accepted directly and never persisted
 * - missing/invalid/expired OAuth token -> 401 (+ WWW-Authenticate with resource metadata)
 * - valid OAuth token for another legacy workspace -> 403
 * Installation-wide OAuth tokens omit the workspace audience check.
 */
export function bearerAuth(deps: BearerAuthDeps) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const challenge = (error: string, description: string): string =>
      `Bearer realm="c2c", error="${error}", error_description="${description}", ` +
      `resource_metadata="${deps.getBaseUrl(req)}/.well-known/oauth-protected-resource/mcp"`;

    const header = req.headers.authorization;
    if (!header || !header.toLowerCase().startsWith("bearer ")) {
      res
        .status(401)
        .set("WWW-Authenticate", challenge("invalid_token", "Missing bearer token"))
        .json({ error: "unauthorized", error_description: "Authentication required" });
      return;
    }
    const token = header.slice(7).trim();
    if (deps.internalBearer && safeEqual(token, deps.internalBearer.token)) {
      const authInfo: AuthInfo = {
        token,
        clientId: deps.internalBearer.clientId,
        scopes: [...deps.internalBearer.scopes],
      };
      (req as Request & { auth?: AuthInfo }).auth = authInfo;
      next();
      return;
    }

    const verdict = deps.store.verifyAccessToken(token);
    if (!verdict.ok) {
      deps.logger.warn(`Rejected MCP request: token ${verdict.reason}`);
      res
        .status(401)
        .set("WWW-Authenticate", challenge("invalid_token", `Token ${verdict.reason}`))
        .json({ error: "unauthorized", error_description: `Token ${verdict.reason}` });
      return;
    }
    if (deps.workspaceId !== undefined && verdict.record.workspaceId !== deps.workspaceId) {
      deps.logger.warn("Rejected MCP request: token bound to a different workspace");
      res.status(403).json({
        error: "forbidden",
        error_description: "This token is not authorized for the connected workspace",
      });
      return;
    }
    const authInfo: AuthInfo = {
      token,
      clientId: verdict.record.clientId,
      scopes: verdict.record.scopes,
      expiresAt: Math.floor(verdict.record.expiresAt / 1000),
    };
    (req as Request & { auth?: AuthInfo }).auth = authInfo;
    next();
  };
}
