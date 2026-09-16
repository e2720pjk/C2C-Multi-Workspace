import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { findInstallationObservation, writeRuntimeState } from "../src/bridge/runtime.js";
import { startBridge } from "../src/bridge/server.js";
import { acquireStateLock, inspectStateLock } from "../src/config/lock.js";
import { ensureInstallationIdentity } from "../src/config/installation.js";
import { ensureBridge, stopBridge } from "../src/process/daemon.js";
import { RUNTIME_BUILD_ID, RUNTIME_CONTRACT_ID, SERVICE_NAME, VERSION } from "../src/version.js";
import { Workspace } from "../src/workspace/manager.js";
import { workspaceRegistryFile, WorkspaceRegistry } from "../src/workspace/registry.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

function runNodeCli(
  nodeArgs: string[],
  state: string,
  env: NodeJS.ProcessEnv = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, nodeArgs, {
      env: { ...process.env, ...env, C2C_STATE_DIR: state },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function runCli(
  args: string[],
  state: string,
  env: NodeJS.ProcessEnv = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return runNodeCli(["--import", "tsx/esm", path.join(process.cwd(), "src", "cli", "index.ts"), ...args], state, env);
}

function runOfficialCli(args: string[], state: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return runNodeCli([path.join(process.cwd(), "bin", "c2c.js"), ...args], state);
}

function runCliStart(root: string, state: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return runCli(["start", "--workspace", root, "--json"], state);
}

function baseRuntime(root: string) {
  const workspace = new Workspace(root);
  return {
    service: SERVICE_NAME,
    version: VERSION,
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    pid: 999_999_999,
    port: 1,
    adminToken: "test",
    publicUrl: null,
    startedAt: new Date().toISOString(),
  };
}

describe("installation lifecycle ownership", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("serializes concurrent independent CLI starts and reuses one daemon", async () => {
    const state = isolateStateDir();
    const a = makeTmpDir("lifecycle-cli-a");
    const b = makeTmpDir("lifecycle-cli-b");
    dirs.push(state, a, b);
    write(a, "a.txt", "a");
    write(b, "b.txt", "b");
    const [first, second] = await Promise.all([runCliStart(a, state), runCliStart(b, state)]);
    try {
      expect(first.code, first.stderr).toBe(0);
      expect(second.code, second.stderr).toBe(0);
      const firstJson = JSON.parse(first.stdout.trim()) as { port: number };
      const secondJson = JSON.parse(second.stdout.trim()) as { port: number };
      expect(firstJson.port).toBe(secondJson.port);
    } finally {
      await stopBridge();
    }
  });

  it("manages a healthy service through the official CLI start/status/restart/stop lifecycle", async () => {
    const state = isolateStateDir();
    const root = makeTmpDir("lifecycle-official-cli");
    dirs.push(state, root);
    write(root, "a.txt", "a");

    try {
      const started = await runOfficialCli(["start", "--workspace", root, "--json"], state);
      expect(started.code, started.stderr).toBe(0);

      const before = await runOfficialCli(["status", "--workspace", root, "--json"], state);
      expect(before.code, before.stderr).toBe(0);
      const beforeStatus = JSON.parse(before.stdout.trim()) as { running: boolean; compatible: boolean; pid: number; port: number };
      expect(beforeStatus).toMatchObject({ running: true, compatible: true });
      const mcpBefore = await fetch(`http://127.0.0.1:${beforeStatus.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(mcpBefore.status).toBe(401);
      const doctor = await runOfficialCli(["doctor", "--workspace", root, "--no-fix", "--json"], state);
      expect(doctor.code, doctor.stderr).toBe(0);
      expect(JSON.parse(doctor.stdout.trim())).toMatchObject({
        report: { bridge: { ok: true }, mcp: { ok: true } },
      });

      const restarted = await runOfficialCli(["restart", "--workspace", root], state);
      expect(restarted.code, restarted.stderr).toBe(0);
      const after = await runOfficialCli(["status", "--workspace", root, "--json"], state);
      expect(after.code, after.stderr).toBe(0);
      const afterStatus = JSON.parse(after.stdout.trim()) as { running: boolean; compatible: boolean; pid: number; port: number };
      expect(afterStatus).toMatchObject({ running: true, compatible: true });
      expect(afterStatus.pid).not.toBe(beforeStatus.pid);

      const stopped = await runOfficialCli(["stop", "--workspace", root], state);
      expect(stopped.code, stopped.stderr).toBe(0);
      const finalStatus = await runOfficialCli(["status", "--workspace", root, "--json"], state);
      expect(JSON.parse(finalStatus.stdout.trim())).toMatchObject({ running: false, state: "stopped" });
    } finally {
      await stopBridge().catch(() => undefined);
    }
  });

  it("serializes concurrent installation starts and reuses one daemon", async () => {
    const state = isolateStateDir();
    const a = makeTmpDir("lifecycle-a");
    const b = makeTmpDir("lifecycle-b");
    dirs.push(state, a, b);
    write(a, "a.txt", "a");
    write(b, "b.txt", "b");
    const port = 47000 + Math.floor(Math.random() * 500);

    const [first, second] = await Promise.all([
      ensureBridge(a, { port }),
      ensureBridge(b, { port }),
    ]);
    try {
      expect(first.runtime.pid).toBe(second.runtime.pid);
      expect(first.runtime.port).toBe(second.runtime.port);
      expect(first.runtime.workspaceIds).toEqual(expect.arrayContaining([new Workspace(a).id, new Workspace(b).id]));
    } finally {
      await stopBridge();
    }
  });

  it("fails closed on malformed shared registry state", () => {
    const state = isolateStateDir();
    const root = makeTmpDir("lifecycle-registry-corrupt");
    dirs.push(state, root);
    const file = path.join(state, "workspaces.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{broken", { mode: 0o600 });
    expect(() => new WorkspaceRegistry()).toThrow(/registry is not valid JSON/i);
  });

  it("lets a reinstalled official CLI reuse then explicitly restart an owned same-contract daemon", async () => {
    const state = isolateStateDir();
    const root = makeTmpDir("lifecycle-upgrade");
    dirs.push(state, root);
    write(root, "a.txt", "a");
    const old = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: true,
      runtimeBuildId: "c2c-build-test-a",
      exitOnShutdown: false,
    });
    try {
      const before = await runOfficialCli(["status", "--workspace", root, "--json"], state);
      expect(before.code, before.stderr).toBe(0);
      expect(JSON.parse(before.stdout.trim())).toMatchObject({ running: true, compatible: true, pid: process.pid });

      const reused = await runOfficialCli(["start", "--workspace", root, "--json"], state);
      expect(reused.code, reused.stderr).toBe(0);
      const afterStart = await runOfficialCli(["status", "--workspace", root, "--json"], state);
      expect(JSON.parse(afterStart.stdout.trim())).toMatchObject({ running: true, pid: process.pid });
      const doctor = await runOfficialCli(["doctor", "--workspace", root, "--no-fix", "--json"], state);
      expect(doctor.code, doctor.stderr).toBe(0);
      expect(JSON.parse(doctor.stdout.trim())).toMatchObject({ report: { bridge: { ok: true }, mcp: { ok: true } } });

      const restarted = await runOfficialCli(["restart", "--workspace", root], state);
      expect(restarted.code, restarted.stderr).toBe(0);
      const status = await runOfficialCli(["status", "--workspace", root, "--json"], state);
      expect(status.code, status.stderr).toBe(0);
      const current = JSON.parse(status.stdout.trim()) as { running: boolean; compatible: boolean; pid: number };
      expect(current).toMatchObject({ running: true, compatible: true });
      expect(current.pid).not.toBe(process.pid);
    } finally {
      await stopBridge();
      await old.close();
    }
  });

  it("does not stop a healthy daemon for an invalid OpenAI candidate", async () => {
    const state = isolateStateDir();
    const root = makeTmpDir("lifecycle-invalid-provider");
    dirs.push(state, root);
    write(root, "a.txt", "a");
    const bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: true, exitOnShutdown: false });
    try {
      const result = await runCli(
        ["tunnel", "choose", "--mode", "openai", "--json"],
        state,
        { CONTROL_PLANE_TUNNEL_ID: "tunnel_0123456789abcdef0123456789abcdef", CONTROL_PLANE_API_KEY: "" }
      );
      expect(result.code).toBe(1);
      expect(result.stdout).toMatch(/INCOMPLETE_OPENAI_CONFIGURATION/);
      expect((await findInstallationObservation(undefined, {
        expectedInstallationId: bridge.installationId,
        expectedContractId: RUNTIME_CONTRACT_ID,
        expectedBuildId: RUNTIME_BUILD_ID,
      })).state).toBe("healthy");
    } finally {
      await bridge.close();
    }
  });

  it("does not classify a mismatched runtime contract as reusable", async () => {
    const state = isolateStateDir();
    const root = makeTmpDir("lifecycle-contract");
    dirs.push(state, root);
    write(root, "a.txt", "a");
    const runtime = {
      ...baseRuntime(root),
      installationId: "c2c_inst_test",
      contractId: "old-contract",
      buildId: "old-build",
      ownerToken: "old-owner",
    };
    writeRuntimeState({ ...runtime, workspaceIds: [runtime.workspaceId] });
    const observation = await findInstallationObservation(undefined, {
      expectedInstallationId: "c2c_inst_test",
      expectedContractId: RUNTIME_CONTRACT_ID,
      expectedBuildId: RUNTIME_BUILD_ID,
    });
    expect(observation.state).toBe("unknown");
    if (observation.state === "unknown") expect(observation.reason).toBe("contract_mismatch");
  });

  it("refuses to terminate a live process without verifiable ownership", async () => {
    const state = isolateStateDir();
    const root = makeTmpDir("lifecycle-live-pid");
    dirs.push(state, root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    writeRuntimeState({
      ...baseRuntime(root),
      installationId: ensureInstallationIdentity().installationId,
      contractId: RUNTIME_CONTRACT_ID,
      buildId: RUNTIME_BUILD_ID,
      ownerToken: "not-the-owner",
      pid: process.pid,
      workspaceIds: [workspace.id],
    });
    await expect(stopBridge()).rejects.toThrow(/unverifiable|uncertain/);
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });

  it("fails closed on a corrupt workspace registry", () => {
    const state = isolateStateDir();
    dirs.push(state);
    const file = workspaceRegistryFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not-json", { mode: 0o600 });
    expect(() => new WorkspaceRegistry().list()).toThrow(/not valid JSON/);
  });

  it("does not treat malformed state as free, but reclaims a dead owner", () => {
    const state = isolateStateDir();
    dirs.push(state);
    const lockPath = `${state}/runtime/test-owner.lock`;
    const lock = acquireStateLock(lockPath);
    lock.release();
    // The normal lock path is owner-only and inspectable; malformed locks are
    // intentionally not reclaimed by lifecycle code.
    fs.mkdirSync(lockPath, { recursive: true });
    expect(inspectStateLock(lockPath).state).toBe("unknown");
    fs.rmSync(lockPath, { recursive: true, force: true });
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(`${lockPath}/owner.json`, JSON.stringify({
      pid: 999_999_999,
      token: "dead",
      processIdentity: "dead",
      acquiredAt: new Date().toISOString(),
    }));
    const reclaimed = acquireStateLock(lockPath, { timeoutMs: 100 });
    expect(reclaimed.owner.pid).toBe(process.pid);
    reclaimed.release();
  });
});
