# C2C Multi-Workspace

C2C is a CLI for connecting ChatGPT to registered local workspaces through a read-only MCP Bridge. ChatGPT plans and reviews; your coding agent retains editing, shell, git, and test execution.

This fork extends the usual one-project setup: **one C2C installation and one Connector can manage many registered repositories or worktrees**. Workspace selection happens per request, so changing repositories does not require rebuilding the Connector or restarting the tunnel.

## Upstream and fork differences

This repository is a fork and experimental extension of the [upstream C2C project](https://github.com/XiaoDuoYa/codex-with-chatgpt).

The extension adds:

- one installation-level daemon, MCP endpoint, and tunnel for many workspaces;
- request-scoped workspace ids and aliases, with `list_workspaces` discovery;
- no Connector or tunnel restart when registering or selecting a workspace;
- installation ownership checks for builds, PIDs, stale locks, and orphan tunnel clients;
- OpenAI Secure Tunnel as the recommended default for a persistent ChatGPT connection;
- explicit opt-in to the older Cloudflare + OAuth Pairing profile;
- English CLI output by default, with an explicit Traditional Chinese setting.

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

### 3. Prepare Secure Tunnel (recommended)

On macOS:

```bash
brew install openai/tools/tunnel-client
tunnel-client --version
export CONTROL_PLANE_TUNNEL_ID=tunnel_...
export CONTROL_PLANE_API_KEY=...
```

Obtain an existing Tunnel ID and Runtime API Key outside C2C. C2C runs the official client but does not create/delete Tunnel resources and never requires `OPENAI_ADMIN_KEY`. Keep the key in your local runtime environment, not command arguments or project files.

For Linux or Windows, see the [official OpenAI `tunnel-client` repository](https://github.com/openai/tunnel-client). No tunnel dependency is needed for local-only development.

### 4. First setup

For a public connection:

```bash
c2c setup
```

To use only the local Bridge:

```bash
c2c setup --no-tunnel
```

`setup` registers the current workspace, starts the installation Bridge and selected connection, and prints the MCP URL. In ChatGPT, create one connector with **Connection = Tunnel** and **Authentication = No authentication**. Secure Tunnel does not use pairing codes; its local MCP binding is still protected by a process-scoped bearer.

Missing credentials or `tunnel-client` produce an error, never an automatic Pairing fallback. `setup --no-tunnel` starts only the local Bridge for development; it does not provide a remote ChatGPT endpoint. Neither setup mode generates a pairing code.

## Connection profiles

| Profile | Transport | ChatGPT authentication | Selection |
| --- | --- | --- | --- |
| Secure Tunnel | Official OpenAI `tunnel-client` | No authentication (C2C's local bearer is internal) | Default for unconfigured installations |
| Pairing | Cloudflare Quick or Named Tunnel | OAuth + one-time pairing code | Explicit `c2c connection use pairing` |

To use the older Pairing flow:

```bash
brew install cloudflared
c2c connection use pairing
c2c setup
# Create the ChatGPT connector using the printed HTTPS MCP URL and OAuth.
# Only when ChatGPT opens the authorization form:
c2c pair
```

Quick URLs may change after a restart. For a stable Cloudflare hostname, explicitly choose:

```bash
c2c connection use pairing --transport named --zone example.com
c2c setup
```

Named transport needs a Cloudflare account and a domain already managed there. Failed provisioning leaves the existing profile unchanged; it does not silently switch to Quick. See the [Cloudflare installation documentation](https://developers.cloudflare.com/tunnel/downloads/).

To return to Secure Tunnel after preparing its runtime configuration:

```bash
c2c connection use secure
c2c setup
```

Changing profiles stops the existing owned Bridge when necessary. Run setup/start afterwards and update the ChatGPT connector's URL and authentication settings. Adding a workspace does **not** switch profiles or recreate the connector.

## CLI: what do I want to do?

### I want to start the current project

```bash
c2c start
c2c status
```

`start` and `restart` establish the selected connection by default. Use `--no-tunnel` for a local-only development Bridge. `setup` also prints initial connector instructions.

### I want to add another repository or worktree

Use a positional path, or omit it to register the current directory:

```bash
c2c workspace add
c2c workspace add /path/to/repository --alias main
c2c workspace add /path/to/worktree --alias review
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

### I want to inspect or switch connection profiles

```bash
c2c connection status
c2c connection use secure
c2c connection use pairing
```

Secure selection validates the Tunnel ID, Runtime API Key, and client before changing a healthy installation. `pair` and `unpair` only work in Pairing mode; `unpair` revokes OAuth access for **all** registered workspaces. Use `c2c stop` to stop a Secure connection; upstream Tunnel access is managed outside C2C.

### I want to set the CLI language

```bash
c2c prefs set --language en       # default, regardless of OS locale
c2c prefs set --language zh-TW    # explicit Traditional Chinese
c2c prefs --json
```

Language is installation-wide. JSON keys, profile names, and error codes stay stable; human-facing messages use the selected language. User content and third-party diagnostics are not translated.

Existing persisted `quick`, `named`, and `openai` choices are retained. Legacy `tunnel choose --mode openai|quick|named`, `workspace register`, `workspace default`, and `workspace add -w <path>` remain accepted but hidden from the main help. Installation-wide commands accept and ignore leftover `-w`; workspace-specific commands still use it to select a local root. Do not combine a positional add path with `-w`.

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
- Local-only startup can reuse an ownership-verified, same-contract older daemon. Public startup and repair require the selected profile and current build; otherwise C2C asks for an explicit `restart`.
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

CLI flow diagram: [`docs/cli-workflows.html`](docs/cli-workflows.html).

More detail: [`docs/architecture.md`](docs/architecture.md), [`docs/multi-workspace.md`](docs/multi-workspace.md), [`docs/security.md`](docs/security.md), and [`docs/troubleshooting.md`](docs/troubleshooting.md).

## License

MIT
