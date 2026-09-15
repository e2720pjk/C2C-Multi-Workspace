# Multi-workspace

C2C now runs one installation-level MCP endpoint for a registered set of
workspaces. The daemon owns an installation id, runtime contract id, and source
build fingerprint; a CLI never silently reuses a daemon that cannot prove all
three match. A workspace is selected per MCP request; selecting another
workspace does not change the Connector or restart the tunnel.

## Manage the local allowlist

```bash
c2c workspace add --workspace /path/to/main --alias main
c2c workspace add --workspace /path/to/gemini-refactor --alias gemini-refactor
c2c workspace list --json
c2c workspace set-default main
c2c workspace disable gemini-refactor
c2c workspace enable gemini-refactor
c2c workspace remove gemini-refactor
```

`workspace list` exposes the stable id, alias, display name, branch/basic
project metadata, availability, enabled state, and default state. It does not
print the canonical local root in discovery output. Use `c2c workspace` for
local diagnostics when you explicitly need the current path.

With one enabled registration, a request may omit `workspace`. Once multiple workspaces are enabled, omission requires an explicit default choice. `set-default` changes it.
The persisted default is stable until changed. A request without `workspace` uses it. A
request with an unknown, disabled, removed, or colliding selector fails; it
never falls back to the default. If a default becomes unavailable, omitted
routing fails closed until the registration is repaired or the default is
changed.

## MCP usage

The installation exposes `list_workspaces` for its registered workspace set.
Workspace-dependent tools accept an optional `workspace` value,
which is either the exact `workspaceId` or an alias returned by discovery:

```json
{"name":"git_status","arguments":{"workspace":"main"}}
{"name":"read_file","arguments":{"workspace":"gemini-refactor","path":"src/tunnel/openai.ts"}}
```

The existing single-workspace form remains valid:

```json
{"name":"read_file","arguments":{"path":"README.md"}}
```

The workspace-aware tools are `workspace_info`, `list_directory`, `read_file`,
`search_workspace`, `git_status`, `git_diff`, `test_status`,
`execution_summary`, and `execution_output`. `list_workspaces` is the
installation-level discovery tool.

## Identity and security

A registration stores:

- `workspaceId`: the first 12 hex characters of SHA-256 over the canonical,
  case-normalized root;
- `alias` and `displayName` for humans and the model;
- the canonical root (local installation state only);
- `enabled`, registration timestamps, and the installation default id.

Because the id is derived from the canonical root, two worktrees of one
repository have different ids and remain independent routing targets. Alias collisions are rejected during registration. A malformed legacy state with
colliding aliases fails closed and must be repaired locally before routing.

A workspace-relative path is still canonicalized and checked against the
selected registered root. `..`, absolute escapes, canonical symlink escapes,
sensitive files, and disabled/unavailable registrations fail closed. Routing
never accepts a filesystem root supplied by the model.

The registry, installation OAuth state, runtime/admin state, and tunnel
runtime belong to the C2C installation. Git state, execution records, and
filesystem contents remain keyed by the selected workspace id. OAuth tokens
authorize the installation endpoint; the `workspace` argument only selects
one member of its pre-registered allowlist.

## Installation lifecycle

`c2c start` from any registered worktree first records that workspace, then
serializes installation startup. The shared installation identity is created
under a lock, the daemon owns an owner lock for its lifetime, and the runtime
file is atomically replaced. `c2c stop`/`restart` are installation operations;
`workspace disable` and `workspace remove` manage only registry membership.
`c2c status --json` reports the current workspace, registered count, daemon
contract/build identity, tunnel state, and any stopped/unknown/conflicting
state. A corrupt runtime or unverifiable PID is never treated as permission to
kill a process or start a second daemon.

## Installation lifecycle ownership

`c2c start` first registers the current root, then takes a short startup lock
and checks the persisted installation identity, runtime contract, build
fingerprint, owner lock, PID identity, and health response. The daemon holds
the owner lock for its lifetime. A second terminal waits for the first startup
and reuses the same healthy runtime; it cannot create a second daemon merely
because the preferred port is occupied.

`status`, `stop`, and `restart` distinguish `healthy`, `stopped`, and
`unknown/conflicting`. Corrupt state, a failed health probe, an unverifiable
PID, or a contract/build mismatch is reported and fails closed; lifecycle code
does not kill a PID it cannot attribute to this installation.

The registry and installation identity use owner-only, atomically replaced JSON
under an installation lock. Runtime and tunnel state are installation-owned;
workspace registration mutations are serialized read-modify-write operations.

## Connector and tunnel ownership

Set up ChatGPT once with the installation MCP URL. Adding or selecting a
workspace does not create another Connector. The one tunnel provider is owned
by the bridge process and forwards to the same local MCP port. Requests for A
and B can run concurrently, and no routing path calls tunnel start/restart.

Older per-workspace tunnel and endpoint state is read as a migration fallback;
new installation state is written under the installation identity. This checkout also supports the official OpenAI Secure Tunnel client when
`CONTROL_PLANE_TUNNEL_ID` and `CONTROL_PLANE_API_KEY` are set. C2C starts one
installation-owned `tunnel-client` process and uses the connector URL
`<CONTROL_PLANE_BASE_URL>/v1/mcp/<tunnel_id>` (default base:
`https://api.openai.com`). It does not create/delete Tunnel objects and never
requires `OPENAI_ADMIN_KEY`. The integration follows the official
[tunnel-client configuration contract](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md)
and [connector endpoint contract](https://github.com/openai/tunnel-client/blob/master/docs/connectors.md).

ChatGPT remains read-only: the MCP server has no file mutation, shell, commit,
or package-install tools. Codex retains execution and mutation authority.
