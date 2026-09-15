import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";
import { appendExecutionRecord } from "../src/execution/records.js";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "../src/tunnel/provider.js";
import { cleanup, git, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

function body(result: { content?: unknown }): Record<string, any> {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0].text) as Record<string, any>;
}

class CountingTunnel implements TunnelProvider {
  readonly name = "test-tunnel";
  starts = 0;
  stops = 0;
  restarts = 0;
  private url: string | null = null;

  async start(_localPort: number): Promise<string> {
    this.starts++;
    this.url = "https://test.example";
    return this.url;
  }

  async stop(): Promise<void> {
    this.stops++;
    this.url = null;
  }

  async restart(_localPort: number): Promise<string> {
    this.restarts++;
    this.url = "https://test.example";
    return this.url;
  }

  status(): TunnelStatus {
    return { running: this.url !== null, url: this.url, provider: this.name };
  }

  getPublicUrl(): string | null {
    return this.url;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    return { provider: this.name, binaryFound: true, binaryPath: "test", running: this.url !== null, url: this.url, problems: [] };
  }
}

describe("installation multi-workspace routing", () => {
  let bridge: Bridge;
  let client: Client;
  let a: string;
  let b: string;

  beforeAll(async () => {
    isolateStateDir();
    a = makeTmpDir("main");
    b = makeTmpDir("gemini-refactor");
    makeGitRepo(a);
    makeGitRepo(b);
    git(b, "branch", "-M", "gemini-refactor");
    write(a, "same.ts", "export const workspace = 'main';\n");
    write(b, "same.ts", "export const workspace = 'gemini-refactor';\n");
    appendExecutionRecord(new Workspace(a).id, {
      taskId: "main-task",
      iteration: 1,
      changedFiles: [],
      tests: "main tests",
      exitStatus: "ok",
      timestamp: new Date().toISOString(),
    });
    appendExecutionRecord(new Workspace(b).id, {
      taskId: "ref-task",
      iteration: 2,
      changedFiles: [],
      tests: "ref tests",
      exitStatus: "failed",
      timestamp: new Date().toISOString(),
    });
    bridge = await startBridge({ workspaceRoots: [a, b], port: 0, persistRuntime: false });
    bridge.registry.register(a, { alias: "main" });
    bridge.registry.register(b, { alias: "gemini-refactor" });
    const token = bridge.authStore.issueTokens({
      clientId: "multi-test",
      scopes: ["workspace.read", "workspace.search", "git.read", "execution.read"],
    }).accessToken;
    client = new Client({ name: "multi-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      })
    );
  });

  afterAll(async () => {
    await client.close();
    await bridge.close();
    cleanup(a);
    cleanup(b);
    delete process.env.C2C_STATE_DIR;
  });

  it("discovers both registered roots without returning absolute paths", async () => {
    const result = await client.callTool({ name: "list_workspaces", arguments: {} });
    const data = body(result) as { workspaces: Array<Record<string, any>> };
    expect(data.workspaces.map((item) => item.alias)).toEqual(["main", "gemini-refactor"]);
    expect(data.workspaces.every((item) => !JSON.stringify(item).includes(a))).toBe(true);
    expect(data.workspaces.every((item) => !JSON.stringify(item).includes(b))).toBe(true);
  });

  it("routes explicit reads to the selected workspace", async () => {
    const [main, ref] = await Promise.all([
      client.callTool({ name: "read_file", arguments: { workspace: "main", path: "same.ts" } }),
      client.callTool({ name: "read_file", arguments: { workspace: "gemini-refactor", path: "same.ts" } }),
    ]);
    expect(body(main).content).toContain("main");
    expect(body(ref).content).toContain("gemini-refactor");
  });

  it("fails closed for unknown, disabled, and ambiguous selectors", async () => {
    const unknown = await client.callTool({ name: "workspace_info", arguments: { workspace: "does-not-exist" } });
    expect(body(unknown).error).toBe("UNKNOWN_WORKSPACE");

    bridge.registry.setEnabled("gemini-refactor", false);
    const disabled = await client.callTool({ name: "workspace_info", arguments: { workspace: "gemini-refactor" } });
    expect(body(disabled).error).toBe("DISABLED_WORKSPACE");
    bridge.registry.setEnabled("gemini-refactor", true);

    const removed = makeTmpDir("removed");
    write(removed, "x.txt", "removed");
    bridge.registry.register(removed, { alias: "removed" });
    bridge.registry.remove("removed");
    const removedResult = await client.callTool({ name: "workspace_info", arguments: { workspace: "removed" } });
    expect(body(removedResult).error).toBe("UNKNOWN_WORKSPACE");
    cleanup(removed);

    const c = makeTmpDir("ambiguous-c");
    const d = makeTmpDir("ambiguous-d");
    write(c, "x.txt", "c");
    write(d, "x.txt", "d");
    bridge.registry.register(c, { alias: "same" });
    bridge.registry.register(d, { alias: "same" });
    const ambiguous = await client.callTool({ name: "workspace_info", arguments: { workspace: "same" } });
    expect(body(ambiguous).error).toBe("AMBIGUOUS_WORKSPACE");
    bridge.registry.remove(new Workspace(c).id);
    bridge.registry.remove(new Workspace(d).id);
    cleanup(c);
    cleanup(d);
  });

  it("routes git and execution state to the selected root", async () => {
    const [main, ref] = await Promise.all([
      client.callTool({ name: "git_status", arguments: { workspace: "main" } }),
      client.callTool({ name: "git_status", arguments: { workspace: "gemini-refactor" } }),
    ]);
    expect(body(main).branch).toBe("main");
    expect(body(ref).branch).toBe("gemini-refactor");
    const execution = await client.callTool({ name: "execution_summary", arguments: { workspace: "gemini-refactor" } });
    expect(body(execution).records[0].taskId).toBe("ref-task");

    const [idA, idB] = await Promise.all([
      client.callTool({ name: "workspace_info", arguments: { workspace: "main" } }),
      client.callTool({ name: "workspace_info", arguments: { workspace: "gemini-refactor" } }),
    ]);
    expect(body(idA).workspaceId).not.toBe(body(idB).workspaceId);
  });

  it("keeps path confinement per selected root", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { workspace: "main", path: "../gemini-refactor/same.ts" } });
    expect(result.isError).toBe(true);
    expect(body(result).error).toBe("PATH_OUTSIDE_WORKSPACE");
  });

  it("does not restart the installation tunnel while routing A and B", async () => {
    const tunnel = new CountingTunnel();
    const routedBridge = await startBridge({
      workspaceRoots: [a, b],
      port: 0,
      persistRuntime: false,
      tunnelProvider: tunnel,
    });
    const token = routedBridge.authStore.issueTokens({
      clientId: "tunnel-test",
      scopes: ["workspace.read"],
    }).accessToken;
    const routedClient = new Client({ name: "tunnel-test", version: "1" });
    await routedClient.connect(
      new StreamableHTTPClientTransport(new URL(`${routedBridge.localBaseUrl()}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      })
    );
    await tunnel.start(routedBridge.port);
    await Promise.all([
      routedClient.callTool({ name: "read_file", arguments: { workspace: "main", path: "same.ts" } }),
      routedClient.callTool({ name: "read_file", arguments: { workspace: "gemini-refactor", path: "same.ts" } }),
    ]);
    expect(tunnel.starts).toBe(1);
    expect(tunnel.restarts).toBe(0);
    await routedClient.close();
    await routedBridge.close();
  });

  it("uses a stable default without changing it during concurrent calls", async () => {
    const defaultResult = await client.callTool({ name: "workspace_info", arguments: {} });
    expect(body(defaultResult).workspaceId).toBe(new Workspace(a).id);
    const registry = bridge.registry as WorkspaceRegistry;
    expect(registry.defaultWorkspaceId()).toBe(new Workspace(a).id);
  });
});

describe("workspace identity across worktrees", () => {
  it("uses canonical roots, not repository names, for ids", () => {
    const repo = makeTmpDir("worktree-main");
    const worktree = path.join(path.dirname(repo), "worktree-gemini-refactor");
    const state = makeTmpDir("worktree-registry-state");
    makeGitRepo(repo);
    git(repo, "worktree", "add", "-b", "gemini-refactor", worktree);
    try {
      const main = new Workspace(repo);
      const refactor = new Workspace(worktree);
      expect(main.id).not.toBe(refactor.id);
      const registry = new WorkspaceRegistry({ file: path.join(state, "workspaces.json") });
      registry.register(repo, { alias: "main" });
      registry.register(worktree, { alias: "gemini-refactor" });
      expect(registry.summaries().map((item) => item.branch)).toEqual(["main", "gemini-refactor"]);
    } finally {
      git(repo, "worktree", "remove", "--force", worktree);
      cleanup(repo);
      cleanup(worktree);
      cleanup(state);
    }
  });
});
