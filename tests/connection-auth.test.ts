import path from "node:path";
import { describe, expect, it } from "vitest";
import { startBridge } from "../src/bridge/server.js";
import { mergeUiPrefs } from "../src/config/ui-prefs.js";
import type { TunnelProvider } from "../src/tunnel/provider.js";
import { cleanup, isolateStateDir, makeTmpDir, pkceVerifierAndChallenge } from "./helpers.js";

function provider(name: string): TunnelProvider {
  return {
    name,
    start: async () => null, stop: async () => {}, restart: async () => null,
    status: () => ({ running: false, url: null, provider: name }),
    getPublicUrl: () => null,
    doctor: async () => ({ provider: name, binaryFound: true, binaryPath: null, running: false, url: null, problems: [] }),
  };
}

describe("connection authentication profiles", () => {
  it("disables OAuth and pairing in Secure mode and rejects old OAuth credentials", async () => {
    const state = isolateStateDir();
    const root = makeTmpDir("secure-auth");
    const bridge = await startBridge({
      workspaceRoot: root, port: 0, persistRuntime: false,
      authStoreFile: path.join(state, "auth.json"), tunnelProvider: provider("openai-secure"),
    });
    const base = bridge.localBaseUrl();
    try {
      expect((await fetch(`${base}/.well-known/oauth-authorization-server`)).status).toBe(404);
      expect((await fetch(`${base}/oauth/register`, { method: "POST" })).status).toBe(404);
      const pairing = await fetch(`${base}/admin/pairing`, {
        method: "POST", headers: { authorization: `Bearer ${bridge.adminToken}` },
      });
      expect(pairing.status).toBe(409);
      expect(await pairing.json()).toMatchObject({ error: "PAIRING_DISABLED" });
      expect(bridge.pairing.hasActiveSession()).toBe(false);
      const call = (token: string) => fetch(`${base}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      for (const clientId of ["legacy-oauth", "c2c-openai-tunnel"]) {
        const tokens = bridge.authStore.issueTokens({ clientId, scopes: ["workspace.read"] });
        expect((await call(tokens.accessToken)).status).toBe(403);
      }
      const internal = bridge.authStore.issueInternalToken({ clientId: "c2c-openai-tunnel", scopes: ["workspace.read"] });
      expect((await call(internal)).status).toBe(200);
    } finally {
      await bridge.close();
      cleanup(root); cleanup(state); delete process.env.C2C_STATE_DIR;
    }
  });

  it("keeps Pairing OAuth available and updates its page language without restarting", async () => {
    const state = isolateStateDir();
    const root = makeTmpDir("pairing-language");
    const bridge = await startBridge({
      workspaceRoot: root, port: 0, persistRuntime: false,
      authStoreFile: path.join(state, "auth.json"), tunnelProvider: provider("cloudflare-quick"),
    });
    const base = bridge.localBaseUrl();
    try {
      const pairing = await fetch(`${base}/admin/pairing`, {
        method: "POST", headers: { authorization: `Bearer ${bridge.adminToken}` },
      });
      expect(pairing.status).toBe(200);
      const redirect = "http://127.0.0.1:19999/callback";
      const client = bridge.authStore.registerClient({ redirectUris: [redirect] });
      const { challenge } = pkceVerifierAndChallenge();
      const url = new URL(`${base}/oauth/authorize`);
      url.search = new URLSearchParams({
        client_id: client.clientId, redirect_uri: redirect, response_type: "code",
        code_challenge: challenge, code_challenge_method: "S256",
      }).toString();
      const english = await (await fetch(url)).text();
      expect(english).toContain('lang="en"');
      expect(english).toContain("Run c2c pair");
      expect(english).not.toMatch(/\p{Script=Han}/u);
      mergeUiPrefs({ language: "zh-TW" });
      const traditional = await (await fetch(url)).text();
      expect(traditional).toContain('lang="zh-TW"');
      expect(traditional).toContain("配對碼");
      expect(traditional).toContain("僅限使用一次");
    } finally {
      await bridge.close();
      cleanup(root); cleanup(state); delete process.env.C2C_STATE_DIR;
    }
  });
});
