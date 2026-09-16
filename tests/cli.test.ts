import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cleanup, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");

function runCli(args: string[], stateDir: string) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", cliEntry, ...args],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: { ...process.env, C2C_STATE_DIR: stateDir },
    },
  );
}

describe("c2c CLI guidance", () => {
  it("keeps tunnel choices and connector rules visible in help", () => {
    const stateDir = makeTmpDir("cli-help-state");
    try {
      const result = runCli(["help"], stateDir);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("c2c start -w <workspace> --tunnel");
      expect(result.stdout).toContain("Quick");
      expect(result.stdout).toContain("Named");
      expect(result.stdout).toContain("OpenAI");
      expect(result.stdout).toContain("No authentication");
      expect(result.stdout).toContain("pairing code");
    } finally {
      cleanup(stateDir);
    }
  });

  it("reports selected mode separately from live Bridge/Tunnel state in JSON", () => {
    const stateDir = makeTmpDir("cli-tunnel-status-state");
    const workspace = makeTmpDir("cli-tunnel-status-workspace");
    try {
      const result = runCli(["tunnel", "status", "--workspace", workspace, "--json"], stateDir);
      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: true,
        preference: "unset",
        selectedModeLabel: expect.stringContaining("尚未选择"),
        bridgeRunning: false,
        tunnelRunning: false,
      });
    } finally {
      cleanup(workspace);
      cleanup(stateDir);
    }
  });
});
