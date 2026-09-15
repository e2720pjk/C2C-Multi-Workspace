# Multi-workspace

C2C now runs one installation-level MCP endpoint for a registered set of
workspaces. A workspace is selected per MCP request; selecting another
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

The first registered workspace becomes the default. `set-default` changes it
explicitly. A request without `workspace` uses that persisted default. A
request with an unknown, disabled, removed, or ambiguous selector fails; it
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
repository have different ids and remain independent routing targets. Alias
collisions are allowed in local state so they can be shown and repaired, but
an ambiguous alias is rejected at request time.

A workspace-relative path is still canonicalized and checked against the
selected registered root. `..`, absolute escapes, canonical symlink escapes,
sensitive files, and disabled/unavailable registrations fail closed. Routing
never accepts a filesystem root supplied by the model.

The registry, installation OAuth state, runtime/admin state, and tunnel
runtime belong to the C2C installation. Git state, execution records, and
filesystem contents remain keyed by the selected workspace id. OAuth tokens
authorize the installation endpoint; the `workspace` argument only selects
one member of its pre-registered allowlist.

## Connector and tunnel ownership

Set up ChatGPT once with the installation MCP URL. Adding or selecting a
workspace does not create another Connector. The one tunnel provider is owned
by the bridge process and forwards to the same local MCP port. Requests for A
and B can run concurrently, and no routing path calls tunnel start/restart.

Older per-workspace tunnel and endpoint state is read as a migration fallback;
new installation state is written under the installation identity. C2C in this
checkout has Cloudflare Quick/Named tunnel providers; no OpenAI Secure Tunnel
provider was present, so no unrelated transport was reimplemented.

ChatGPT remains read-only: the MCP server has no file mutation, shell, commit,
or package-install tools. Codex retains execution and mutation authority.
