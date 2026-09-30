import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");

function runCli(args: string[], stateDir: string, cwd = projectRoot, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", cliEntry, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      CONTROL_PLANE_TUNNEL_ID: "",
      CONTROL_PLANE_API_KEY: "",
      C2C_STATE_DIR: stateDir,
      CODEX_HOME: path.join(stateDir, "codex"),
      ...env,
    },
  });
}

function json(result: ReturnType<typeof runCli>) {
  return JSON.parse(result.stdout.trim());
}

describe("c2c CLI", () => {
  const dirs: string[] = [];
  const temporary = (name: string) => {
    const dir = makeTmpDir(name);
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
  });

  it("documents Secure Tunnel as the default and Pairing as explicit opt-in", () => {
    const result = runCli(["help"], temporary("cli-help"));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Secure Tunnel (default)");
    expect(result.stdout).toContain("c2c connection use pairing");
    expect(result.stdout).toContain("No authentication");
    expect(result.stdout).toContain("authorization form is open");
    expect(result.stdout).not.toMatch(/\p{Script=Han}/u);
  });

  it("reports an unconfigured Secure profile without selecting a fallback", () => {
    const state = temporary("cli-default");
    const result = runCli(["connection", "status", "--json"], state);
    expect(result.status).toBe(0);
    expect(json(result)).toMatchObject({
      ok: true, connectionMode: "secure", preference: "openai", needsChoice: false,
      configured: false, connectorAuthentication: "none", provider: "openai-secure",
      bridgeRunning: false, tunnelRunning: false,
      diagnostic: expect.stringContaining("CONTROL_PLANE_API_KEY"),
    });
    expect(fs.existsSync(path.join(state, "tunnels", "installation.json"))).toBe(false);
  });

  it("does not describe an uncertain bridge as stopped", () => {
    const state = temporary("cli-uncertain-state");
    write(state, "runtime/installation.json", "{broken");
    const result = runCli(["connection", "status", "--json"], state);
    expect(result.status).toBe(1);
    expect(json(result)).toMatchObject({ ok: false, error: expect.stringContaining("BRIDGE_STATE_UNKNOWN") });
  });

  it("fails startup before creating a daemon when Secure configuration is missing", () => {
    const state = temporary("cli-missing-credentials");
    for (const command of ["start", "setup"]) {
      const result = runCli([command, "--json"], state);
      expect(result.status).toBe(1);
      expect(json(result)).toMatchObject({ ok: false, error: expect.stringContaining("INCOMPLETE_OPENAI_CONFIGURATION") });
    }
    expect(fs.existsSync(path.join(state, "runtime", "installation.json"))).toBe(false);
    expect(fs.existsSync(path.join(state, "tunnels", "installation.json"))).toBe(false);
  });

  it("requires explicit Pairing selection and preserves it on an invalid Secure switch", () => {
    const state = temporary("cli-mode-switch");
    expect(json(runCli(["pair", "--json"], state)).error).toContain("PAIRING_DISABLED");
    const selected = runCli(["connection", "use", "pairing", "--json"], state);
    expect(selected.status).toBe(0);
    expect(json(selected)).toMatchObject({ connectionMode: "pairing", provider: "cloudflare-quick" });
    expect(json(runCli(["pair", "--json"], state)).error).toContain("Bridge is not ready");
    const invalid = runCli(["connection", "use", "secure", "--json"], state);
    expect(invalid.status).toBe(1);
    expect(json(runCli(["connection", "status", "--json"], state)).connectionMode).toBe("pairing");
    // Leftover workspace flags never select a root for installation-wide commands.
    expect(runCli(["tunnel", "choose", "--mode", "quick", "-w", "/does-not-exist", "--json"], state).status).toBe(0);
  });

  it("stores a Secure profile without storing its key and never falls back on named failure", () => {
    const state = temporary("cli-secure-choice");
    const cert = write(state, "fake-cert.pem", "test certificate");
    const result = runCli(["connection", "use", "secure", "--json"], state, projectRoot, {
      CONTROL_PLANE_TUNNEL_ID: "tunnel_0123456789abcdef0123456789abcdef",
      CONTROL_PLANE_API_KEY: "runtime-secret",
      C2C_TUNNEL_CLIENT_PATH: process.execPath,
    });
    expect(result.status, result.stdout).toBe(0);
    expect(json(result)).toMatchObject({ connectionMode: "secure", configured: true });
    const stateFile = path.join(state, "tunnels", "installation.json");
    const before = fs.readFileSync(stateFile, "utf8");
    expect(before).not.toContain("runtime-secret");
    const failed = runCli(["connection", "use", "pairing", "--transport", "named", "--zone", "example.com", "--json"], state, projectRoot, {
      C2C_CLOUDFLARED_PATH: process.execPath, TUNNEL_ORIGIN_CERT: cert,
    });
    expect(failed.status).toBe(1);
    expect(json(failed).error).toContain("NAMED_TUNNEL_PROVISION_FAILED");
    expect(fs.readFileSync(stateFile, "utf8")).toBe(before);
  });

  it("accepts positional, current-directory, and legacy workspace paths without ambiguity", () => {
    const state = temporary("cli-workspaces");
    const a = temporary("cli-workspace-a");
    const b = temporary("cli-workspace-b");
    expect(runCli(["workspace", "add", a, "--alias", "a", "--json"], state).status).toBe(0);
    expect(runCli(["workspace", "add", "--alias", "b", "--json"], state, b).status).toBe(0);
    expect(runCli(["workspace", "register", "-w", a, "--json"], state).status).toBe(0);
    expect(runCli(["workspace", "-w", b, "add", "--json"], state).status).toBe(0);
    const conflict = runCli(["workspace", "add", a, "-w", b, "--json"], state);
    expect(conflict.status).toBe(1);
    expect(json(conflict).error).toContain("not both");
    const list = json(runCli(["workspace", "list", "--json"], state));
    expect(list.workspaces.map((workspace: { alias: string }) => workspace.alias).sort()).toEqual(["a", "b"]);
    expect(JSON.stringify(list)).not.toContain(a);
    const help = runCli(["workspace", "add", "--help"], state);
    expect(help.stdout).toContain("[path]");
    expect(help.stdout).not.toContain("--workspace");
  });

  it("defaults to English even under a Chinese OS locale and persists Traditional Chinese explicitly", () => {
    const state = temporary("cli-language");
    const english = runCli(["prefs", "--json"], state, projectRoot, { LANG: "zh_CN.UTF-8", LC_ALL: "zh_CN.UTF-8" });
    expect(json(english).language).toBe("en");
    expect(english.stdout).not.toMatch(/\p{Script=Han}/u);
    const saved = runCli(["prefs", "set", "--language", "zh-TW", "--json"], state);
    expect(saved.status).toBe(0);
    expect(json(saved)).toMatchObject({ language: "zh-TW", setupChoicePrompt: expect.stringContaining("請選擇") });
    expect(runCli(["connection", "use", "--help"], state).stdout).toContain("明確切換至 Pairing");
    expect(runCli(["pair"], state).stdout).toContain("不使用配對碼");
    const invalid = runCli(["prefs", "set", "--language", "zh", "--json"], state);
    expect(invalid.status).toBe(1);
    expect(json(runCli(["prefs", "--json"], state)).language).toBe("zh-TW");
    expect(runCli(["prefs", "set", "--language", "en"], state).stdout).toContain("Language saved: en");
    for (const args of [["prefs"], ["workspace", "list"], ["session"], ["logs"], ["pair"], ["doctor", "--no-fix", "--json"]]) {
      expect(runCli(args, state).stdout).not.toMatch(/\p{Script=Han}/u);
    }
  });

  it("local setup never mints a pairing code in either profile", () => {
    const state = temporary("cli-local-setup");
    const root = temporary("cli-local-workspace");
    try {
      for (const mode of ["secure", "pairing"]) {
        if (mode === "pairing") expect(runCli(["connection", "use", "pairing", "--json"], state).status).toBe(0);
        const setup = runCli(["setup", "-w", root, "--no-tunnel", "--json"], state);
        expect(setup.status, setup.stdout).toBe(0);
        expect(json(setup)).toMatchObject({ connectionMode: mode, local: true, pairingRequired: mode === "pairing" });
        expect(json(setup)).not.toHaveProperty("pairingCode");
        const status = json(runCli(["status", "-w", root, "--json"], state));
        expect(status).toMatchObject({ running: true, pairingActive: false });
        const pair = runCli(["pair", "--json"], state);
        if (mode === "secure") expect(pair.status).toBe(1);
        else expect(json(pair)).toMatchObject({ ok: true, pairingCode: expect.any(String) });
      }
    } finally {
      runCli(["stop", "--json"], state);
    }
  });
});
