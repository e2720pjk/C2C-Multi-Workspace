import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { bearerAuth } from "../src/auth/middleware.js";
import { AuthStore } from "../src/auth/store.js";
import { nullLogger } from "../src/logger/index.js";
import { cleanup, makeTmpDir } from "./helpers.js";

function responseStub(): Response {
  const res = {} as Response;
  res.status = vi.fn(() => res) as Response["status"];
  res.set = vi.fn(() => res) as Response["set"];
  res.json = vi.fn(() => res) as Response["json"];
  return res;
}

describe("bearerAuth internal tunnel credential", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
  });

  it("accepts the process-local tunnel bearer independently of OAuth revocation", () => {
    const stateDir = makeTmpDir("auth-middleware-internal");
    dirs.push(stateDir);
    const store = new AuthStore("installation", { file: path.join(stateDir, "auth.json") });
    const middleware = bearerAuth({
      store,
      internalToken: "internal-secret",
      internalScopes: ["workspace.read", "workspace.search", "git.read", "execution.read"],
      getBaseUrl: () => "http://127.0.0.1:48765",
      logger: nullLogger,
    });

    const invoke = () => {
      const req = { headers: { authorization: "Bearer internal-secret" } } as Request;
      const res = responseStub();
      const next = vi.fn() as unknown as NextFunction;
      middleware(req, res, next);
      return { req, res, next };
    };

    const before = invoke();
    expect(before.next).toHaveBeenCalledOnce();
    expect((before.req as Request & { auth?: AuthInfo }).auth).toMatchObject({
      clientId: "c2c-openai-tunnel",
      scopes: ["workspace.read", "workspace.search", "git.read", "execution.read"],
    });

    store.revokeAll();

    const after = invoke();
    expect(after.next).toHaveBeenCalledOnce();
    expect(after.res.status).not.toHaveBeenCalled();
  });

  it("still rejects an unknown bearer", () => {
    const stateDir = makeTmpDir("auth-middleware-unknown");
    dirs.push(stateDir);
    const store = new AuthStore("installation", { file: path.join(stateDir, "auth.json") });
    const middleware = bearerAuth({
      store,
      internalToken: "internal-secret",
      internalScopes: ["workspace.read"],
      getBaseUrl: () => "http://127.0.0.1:48765",
      logger: nullLogger,
    });
    const req = { headers: { authorization: "Bearer wrong-secret" } } as Request;
    const res = responseStub();
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
