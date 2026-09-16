# C2C Multi-Workspace

C2C lets ChatGPT reach local development files through a loopback Bridge and an MCP endpoint.

This fork extends the usual one-project setup: **one C2C installation and one Connector can manage many registered repositories or worktrees**. Workspace selection happens per request, so changing repositories does not require rebuilding the Connector or restarting the tunnel.

## Upstream and fork differences

This repository is a fork and experimental extension of the [upstream C2C project](https://github.com/XiaoDuoYa/codex-with-chatgpt).

The extension adds:

- one installation-level daemon, MCP endpoint, and tunnel for many workspaces;
- request-scoped workspace ids and aliases, with `list_workspaces` discovery;
- no Connector or tunnel restart when registering or selecting a workspace;
- installation ownership checks for builds, PIDs, stale locks, and orphan tunnel clients;
- optional support for an existing official OpenAI Secure Tunnel.

The implementation is aimed at personal and experimental workflows. See [`docs/`](docs/) for protocol, security, and architecture details.

## Install

### 1. Requirements

- Node.js 20+
- pnpm
- Git

### 2. Clone, build, and install C2C globally

From the repository checkout:

```bash
pnpm install
pnpm build
pnpm install -g .
```

Verify the CLI:

```bash
c2c --help
```

### 3. Install a tunnel dependency (optional for local-only use)

On macOS, choose one of these short paths:

**Cloudflare Quick or Named Tunnel**

```bash
brew install cloudflared
cloudflared --version
```

See the [official Cloudflare `cloudflared` installation documentation](https://developers.cloudflare.com/tunnel/downloads/). Named tunnels also need a Cloudflare account and a domain already in Cloudflare.

**OpenAI Secure Tunnel**

```bash
brew install openai/tools/tunnel-client
tunnel-client --version
```

See the [official OpenAI `tunnel-client` repository](https://github.com/openai/tunnel-client). This installs the official client; C2C still needs an existing Tunnel ID and Runtime API Key.

For Linux or Windows installation, see the relevant official documentation above.

### 4. First setup

For a public connection:

```bash
c2c setup
```

To use only the local Bridge:

```bash
c2c setup --no-tunnel
```

`setup` starts the Bridge and, when a public tunnel is enabled, prints the connection and pairing information for the ChatGPT Connector. `setup --no-tunnel` starts only the local Bridge for development or local testing; it does not provide a public endpoint for a remote ChatGPT Connector.

## Tunnel choices

### Cloudflare Quick

```bash
brew install cloudflared
c2c tunnel choose --mode quick
```

Fastest to start; the public URL may change after a restart.

### Cloudflare Named

```bash
brew install cloudflared
c2c tunnel choose --mode named --zone example.com
```

Needs a Cloudflare account and a domain already added to Cloudflare.

### OpenAI Secure Tunnel

```bash
brew install openai/tools/tunnel-client
export CONTROL_PLANE_TUNNEL_ID=tunnel_...
export CONTROL_PLANE_API_KEY=...
c2c tunnel choose --mode openai
```

This uses an existing OpenAI Tunnel and the official `tunnel-client`. The Runtime API Key is used only at runtime, `OPENAI_ADMIN_KEY` is not required, and C2C does not create or delete Tunnel resources. Start the public connection with `c2c start --tunnel` when needed.

## CLI: what do I want to do?

### I want to start the current project

```bash
c2c start --tunnel
c2c status
```

Use `c2c start` without `--tunnel` for a local-only Bridge. Use `c2c setup` the first time when you also need pairing instructions.

### I want to add another repository or worktree

Run this from any directory; the path and alias are explicit:

```bash
c2c workspace add --workspace /path/to/repository --alias main
c2c workspace add --workspace /path/to/worktree --alias review
c2c workspace list
```

Registration updates the existing installation. It does not create another daemon, Connector, or tunnel.

### I want to choose a default workspace

With one enabled workspace, tools can usually omit the selector. With multiple enabled workspaces, either pass a workspace id or alias on each workspace-dependent call or set a default:

```bash
c2c workspace set-default main
c2c workspace list
```

An ambiguous or missing selection fails closed instead of silently targeting a different repository.

### I want to inspect, repair, restart, or stop C2C

```bash
c2c status   # current lifecycle and tunnel state
c2c doctor   # diagnostics and supported connection repair
c2c restart  # replace the installation daemon
c2c stop     # stop the installation daemon
```

### I want to choose a tunnel

```bash
c2c tunnel status
c2c tunnel choose --mode quick
c2c tunnel choose --mode named --zone example.com
c2c tunnel choose --mode openai
```

OpenAI selection validates the Tunnel ID, Runtime API Key, and official client before taking down a healthy existing daemon. Named-tunnel provisioning is completed before the installation state is changed; a failed candidate does not unnecessarily remove the current connection.

## Multi-workspace model

```text
ChatGPT
   ↓
one C2C Connector / MCP endpoint
   ├── Workspace A
   ├── Workspace B
   └── Workspace C
```

- The Connector and tunnel belong to the installation, not to an individual workspace.
- Workspace-dependent tools accept a workspace id or alias and return `workspaceId` in their results.
- `list_workspaces` is the stable discovery tool.
- If C2C cannot determine one safe workspace, it returns an error rather than guessing.

## Lifecycle and safety

- An installation has one daemon and one installation-owned tunnel.
- `start` and diagnostics reuse an ownership-verified daemon with the same runtime contract, even when its build differs.
- An explicit `restart` upgrades that daemon only after ownership and admin authority are verified; a contract mismatch still fails closed.
- An unverifiable PID, reused PID, corrupt lock, or unknown owner is never killed directly.
- Corrupt or unsupported canonical state fails closed.

If canonical state ever needs a manual reset, first confirm that the old C2C daemon and any `tunnel-client` have stopped. Only then reset local C2C state and run setup again. Do not delete ownership state while a process may still be running.

## Current limitations

- Runtime-contract mismatches do not automatically take over or migrate a daemon.
- Real OpenAI Secure Tunnel behavior still requires a valid external Tunnel, Runtime API Key, and official client; fake-process tests are not control-plane E2E.
- Historical persisted-state migration is intentionally not maintained.
- This fork is currently intended for personal and experimental multi-repository workflows.

## Uninstall

```bash
pnpm remove -g codex-with-chatgpt
```

## Development

```bash
pnpm typecheck
pnpm build
pnpm test
```

More detail: [`docs/architecture.md`](docs/architecture.md), [`docs/multi-workspace.md`](docs/multi-workspace.md), [`docs/security.md`](docs/security.md), and [`docs/troubleshooting.md`](docs/troubleshooting.md).

## License

MIT
