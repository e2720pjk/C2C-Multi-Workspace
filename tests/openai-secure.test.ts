import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { OpenAiSecureTunnel } from "../src/tunnel/openai-secure.js";
import { AuthStore } from "../src/auth/store.js";
import { findBinary } from "../src/tunnel/detect.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const spawnedChildren: ChildProcess[] = [];

function fakeChild(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"]);
  spawnedChildren.push(child);
  return child;
}

describe("OpenAI Secure Tunnel integration", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const child of spawnedChildren) child.kill("SIGTERM");
    spawnedChildren.length = 0;
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    vi.unstubAllEnvs();
  });

  it("discovers the official binary from a C2C-owned override", () => {
    const stateDir = makeTmpDir("openai-tunnel-binary");
    dirs.push(stateDir);
    const binary = path.join(stateDir, "tunnel-client");
    fs.writeFileSync(binary, "#!/bin/sh\n", { mode: 0o700 });
    fs.chmodSync(binary, 0o700);
    vi.stubEnv("C2C_TUNNEL_CLIENT_PATH", binary);
    expect(findBinary("tunnel-client")).toBe(binary);
  });

  it("uses the official tunnel-client contract without persisting the runtime key", async () => {
    const stateDir = makeTmpDir("openai-tunnel-state");
    dirs.push(stateDir);
    const child = fakeChild();
    vi.stubEnv("OPENAI_ADMIN_KEY", "admin-secret");
    let command = "";
    const tunnel = new OpenAiSecureTunnel({
      stateDir,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      apiKey: "runtime-secret",
      binaryResolver: () => "/tmp/tunnel-client",
      spawnProcess: (_binary, args, options) => {
        command = args.join(" ");
        const file = args[args.indexOf("--health.url-file") + 1];
        fs.writeFileSync(file, "http://127.0.0.1:39999\n", { mode: 0o600 });
        expect(options.env?.CONTROL_PLANE_API_KEY).toBe("runtime-secret");
        expect(options.env?.OPENAI_ADMIN_KEY).toBeUndefined();
        expect(command).not.toContain("runtime-secret");
        return child as unknown as ChildProcess;
      },
      readyProbe: async () => true,
    });

    const url = await tunnel.start(48765);
    expect(url).toBe("https://api.openai.com/v1/mcp/tunnel_0123456789abcdef0123456789abcdef");
    expect(tunnel.status().running).toBe(true);
    expect(tunnel.status().url).toBe(url);
    expect(command).toContain("--control-plane.tunnel-id tunnel_0123456789abcdef0123456789abcdef");
    expect(command).toContain("--control-plane.api-key=env:CONTROL_PLANE_API_KEY");
    await tunnel.stop();
    expect(fs.readdirSync(path.join(stateDir, "tunnel-client"))).toHaveLength(0);
    expect(tunnel.status().running).toBe(false);
  });

  it("refreshes the short-lived local MCP authorization without two clients", async () => {
    const stateDir = makeTmpDir("openai-tunnel-auth-refresh");
    dirs.push(stateDir);
    const children = [fakeChild(), fakeChild()];
    const headers: string[] = [];
    const authStore = new AuthStore("installation", { file: path.join(stateDir, "auth.json") });
    const issuedTokens: string[] = [];
    let starts = 0;
    let maxActiveChildren = 0;
    let activeChildren = 0;
    let replaced = 0;
    let resolveReplaced!: () => void;
    const replacedPromise = new Promise<void>((resolve) => { resolveReplaced = resolve; });
    const tunnel = new OpenAiSecureTunnel({
      stateDir,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      apiKey: "runtime-secret",
      binaryResolver: () => "/tmp/tunnel-client",
      spawnProcess: (_binary, args, options) => {
        headers.push(options.env?.C2C_MCP_AUTHORIZATION ?? "");
        expect(args.join(" ")).toContain("--mcp.extra-headers Authorization: env:C2C_MCP_AUTHORIZATION");
        const file = args[args.indexOf("--health.url-file") + 1];
        fs.writeFileSync(file, "http://127.0.0.1:39999\\n", { mode: 0o600 });
        const child = children[starts++];
        if (starts === 2) expect(authStore.verifyAccessToken(issuedTokens[0]).ok).toBe(true);
        activeChildren++;
        maxActiveChildren = Math.max(maxActiveChildren, activeChildren);
        child.once("exit", () => activeChildren--);
        expect(activeChildren).toBe(1);
        return child;
      },
      mcpAuthorization: () => {
        const ttl = issuedTokens.length === 0 ? 1_000 : 60_000;
        const issued = authStore.issueTokens({
          clientId: "c2c-openai-tunnel",
          scopes: ["workspace.read"],
          accessTtlMs: ttl,
        });
        issuedTokens.push(issued.accessToken);
        return { value: `Bearer ${issued.accessToken}`, expiresAt: Date.now() + ttl };
      },
      onAuthorizationReplaced: () => {
        replaced++;
        authStore.revokeToken(issuedTokens[0]);
        resolveReplaced();
      },
      readyProbe: async () => true,
    });
    await tunnel.start(48765);
    await replacedPromise;
    expect(starts).toBe(2);
    expect(headers).toHaveLength(2);
    expect(headers[0]).not.toBe(headers[1]);
    expect(replaced).toBe(1);
    expect(authStore.verifyAccessToken(issuedTokens[0]).ok).toBe(false);
    expect(authStore.verifyAccessToken(issuedTokens[1]).ok).toBe(true);
    expect(maxActiveChildren).toBe(1);
    expect(tunnel.status().authorizationHealthy).toBe(true);
    await tunnel.stop();
  });

  it("fails closed when a replacement client never becomes ready", async () => {
    const stateDir = makeTmpDir("openai-tunnel-auth-failure");
    dirs.push(stateDir);
    const child = fakeChild();
    let starts = 0;
    let activeChildren = 0;
    let maxActiveChildren = 0;
    let invalidated = 0;
    const tunnel = new OpenAiSecureTunnel({
      stateDir,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      apiKey: "runtime-secret",
      startTimeoutMs: 100,
      binaryResolver: () => "/tmp/tunnel-client",
      spawnProcess: (_binary, args) => {
        starts++;
        if (starts > 1) throw new Error("replacement client failed to spawn");
        const file = args[args.indexOf("--health.url-file") + 1];
        fs.writeFileSync(file, "http://127.0.0.1:39999\\n", { mode: 0o600 });
        activeChildren++;
        maxActiveChildren = Math.max(maxActiveChildren, activeChildren);
        child.once("exit", () => activeChildren--);
        return child;
      },
      mcpAuthorization: () => ({ value: `Bearer local-${Date.now()}`, expiresAt: Date.now() + 80 }),
      onAuthorizationInvalidated: () => { invalidated++; },
      readyProbe: async () => true,
    });
    await tunnel.start(48765);
    for (let i = 0; i < 30 && tunnel.status().running; i++) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(starts).toBeGreaterThanOrEqual(2);
    expect(tunnel.status().running).toBe(false);
    expect(tunnel.status().authorizationHealthy).toBe(false);
    expect(tunnel.status().detail).toMatch(/authorization|spawn/i);
    expect(invalidated).toBeGreaterThan(0);
    expect(maxActiveChildren).toBe(1);
    await tunnel.stop();
  });

  it("revokes the local bearer when an unexpected client exit invalidates the channel", async () => {
    const stateDir = makeTmpDir("openai-tunnel-auth-revoke");
    dirs.push(stateDir);
    const child = fakeChild();
    let invalidated = 0;
    const tunnel = new OpenAiSecureTunnel({
      stateDir,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      apiKey: "runtime-secret",
      recoveryLimit: 0,
      binaryResolver: () => "/tmp/tunnel-client",
      spawnProcess: (_binary, args) => {
        const file = args[args.indexOf("--health.url-file") + 1];
        fs.writeFileSync(file, "http://127.0.0.1:39999\\n", { mode: 0o600 });
        return child as unknown as ChildProcess;
      },
      mcpAuthorization: () => ({ value: "Bearer local-token", expiresAt: Date.now() + 60_000 }),
      onAuthorizationInvalidated: () => { invalidated++; },
      readyProbe: async () => true,
    });
    await tunnel.start(48765);
    child.kill("SIGKILL");
    for (let i = 0; i < 20 && invalidated === 0; i++) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(invalidated).toBe(1);
    await tunnel.stop();
  });

  it("recovers one exited client and reads a replacement runtime key", async () => {
    const stateDir = makeTmpDir("openai-tunnel-recovery");
    dirs.push(stateDir);
    const children = [fakeChild(), fakeChild()];
    const keys: string[] = [];
    let starts = 0;
    const tunnel = new OpenAiSecureTunnel({
      stateDir,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      binaryResolver: () => "/tmp/tunnel-client",
      recoveryLimit: 1,
      spawnProcess: (_binary, args, options) => {
        keys.push(options.env?.CONTROL_PLANE_API_KEY ?? "");
        const file = args[args.indexOf("--health.url-file") + 1];
        fs.writeFileSync(file, "http://127.0.0.1:39999\n", { mode: 0o600 });
        return children[starts++];
      },
      readyProbe: async () => true,
    });
    vi.stubEnv("CONTROL_PLANE_API_KEY", "first-key");
    await tunnel.start(48765);
    vi.stubEnv("CONTROL_PLANE_API_KEY", "replacement-key");
    children[0].kill();
    for (let i = 0; i < 30 && starts < 2; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(starts).toBe(2);
    expect(keys).toEqual(["first-key", "replacement-key"]);
    await tunnel.stop();
    expect(tunnel.status().running).toBe(false);
  });

  it("allows only one active client for one installation tunnel owner", async () => {
    const stateDir = makeTmpDir("openai-tunnel-owner");
    dirs.push(stateDir);
    const makeTunnel = () =>
      new OpenAiSecureTunnel({
        stateDir,
        tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
        apiKey: "runtime-secret",
        binaryResolver: () => "/tmp/tunnel-client",
        spawnProcess: (_binary, args) => {
          const file = args[args.indexOf("--health.url-file") + 1];
          fs.writeFileSync(file, "http://127.0.0.1:39999\\n", { mode: 0o600 });
          return fakeChild() as unknown as ChildProcess;
        },
        readyProbe: async () => true,
      });
    const first = makeTunnel();
    const second = makeTunnel();
    await first.start(48765);
    await expect(second.start(48765)).rejects.toThrow(/State lock|held|CONFLICT/);
    await first.stop();
  });

  it("serializes stop against a start", async () => {
    const stateDir = makeTmpDir("openai-tunnel-stop-race");
    dirs.push(stateDir);
    const child = fakeChild();
    const tunnel = new OpenAiSecureTunnel({
      stateDir,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      apiKey: "runtime-secret",
      binaryResolver: () => "/tmp/tunnel-client",
      spawnProcess: (_binary, args) => {
        const file = args[args.indexOf("--health.url-file") + 1];
        fs.writeFileSync(file, "http://127.0.0.1:39999\n", { mode: 0o600 });
        return child as unknown as ChildProcess;
      },
      readyProbe: async () => true,
    });
    await Promise.all([tunnel.start(48765), tunnel.stop()]);
    expect(tunnel.status().running).toBe(false);
  });

  it("enforces one tunnel-client owner per installation state", async () => {
    const stateDir = makeTmpDir("openai-tunnel-owner");
    dirs.push(stateDir);
    const makeTunnel = () =>
      new OpenAiSecureTunnel({
        stateDir,
        tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
        apiKey: "runtime-secret",
        binaryResolver: () => "/tmp/tunnel-client",
        spawnProcess: (_binary, args) => {
          const file = args[args.indexOf("--health.url-file") + 1];
          fs.writeFileSync(file, "http://127.0.0.1:39999\n", { mode: 0o600 });
          return fakeChild() as unknown as ChildProcess;
        },
        readyProbe: async () => true,
      });
    const first = makeTunnel();
    const second = makeTunnel();
    await first.start(48765);
    await expect(second.start(48765)).rejects.toThrow(/owner|lock/i);
    await first.stop();
    await second.start(48765);
    await second.stop();
  });

  it("fails before spawning when the required runtime credential is absent", async () => {
    const stateDir = makeTmpDir("openai-tunnel-missing-key");
    dirs.push(stateDir);
    const spawnProcess = vi.fn(() => fakeChild());
    const tunnel = new OpenAiSecureTunnel({
      stateDir,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      binaryResolver: () => "/tmp/tunnel-client",
      spawnProcess,
    });
    await expect(tunnel.start(48765)).rejects.toThrow(/CONTROL_PLANE_API_KEY/);
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
