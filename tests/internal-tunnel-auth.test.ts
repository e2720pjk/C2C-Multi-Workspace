import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { AuthStore } from "../src/auth/store.js";
import { bearerAuth } from "../src/auth/middleware.js";
import { nullLogger } from "../src/logger/index.js";

function requestWithBearer(token: string): Request {
  return {
    headers: { authorization: `Bearer ${token}` },
  } as unknown as Request;
}

function responseStub(): Response {
  const response = {
    status: vi.fn(),
    set: vi.fn(),
    json: vi.fn(),
  };
  response.status.mockReturnValue(response);
  response.set.mockReturnValue(response);
  response.json.mockReturnValue(response);
  return response as unknown as Response;
}

describe("internal tunnel bearer", () => {
  it("authenticates the installation-owned bearer without consulting the OAuth store", () => {
    const verifyAccessToken = vi.fn();
    const store = { verifyAccessToken } as unknown as AuthStore;
    const request = requestWithBearer("runtime-secret");
    const response = responseStub();
    const next = vi.fn();

    bearerAuth({
      store,
      internalBearer: {
        token: "runtime-secret",
        clientId: "c2c-openai-tunnel",
        scopes: ["workspace.read", "workspace.search", "git.read", "execution.read"],
      },
      getBaseUrl: () => "http://127.0.0.1:48765",
      logger: nullLogger,
    })(request, response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(verifyAccessToken).not.toHaveBeenCalled();
    expect((request as Request & { auth?: AuthInfo }).auth).toEqual({
      token: "runtime-secret",
      clientId: "c2c-openai-tunnel",
      scopes: ["workspace.read", "workspace.search", "git.read", "execution.read"],
    });
  });

  it("keeps the normal OAuth bearer path for any other token", () => {
    const verifyAccessToken = vi.fn(() => ({
      ok: true as const,
      record: {
        workspaceId: "installation",
        clientId: "oauth-client",
        scopes: ["workspace.read"],
        expiresAt: Date.now() + 60_000,
      },
    }));
    const store = { verifyAccessToken } as unknown as AuthStore;
    const request = requestWithBearer("oauth-access-token");
    const response = responseStub();
    const next = vi.fn();

    bearerAuth({
      store,
      internalBearer: {
        token: "runtime-secret",
        clientId: "c2c-openai-tunnel",
        scopes: ["workspace.read"],
      },
      getBaseUrl: () => "http://127.0.0.1:48765",
      logger: nullLogger,
    })(request, response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(verifyAccessToken).toHaveBeenCalledWith("oauth-access-token");
    expect((request as Request & { auth?: AuthInfo }).auth).toMatchObject({
      token: "oauth-access-token",
      clientId: "oauth-client",
      scopes: ["workspace.read"],
    });
  });
});
