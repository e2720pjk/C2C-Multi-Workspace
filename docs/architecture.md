# Architecture

```
             ┌───────────────────────────┐
             │    ChatGPT Web / Sol      │
             │  Reason / Plan / Review   │
             └──────────┬──────────▲─────┘
                        │          │
               MCP      │          │ Computer Use
            Data Plane  │          │ Control Plane
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │
             │  MCP Server (RO)    │
             │  OAuth AS + PRM     │
             │  Pairing Manager    │
             │  Tunnel Manager     │
             │  Workspace Registry │
             │  Admin API (local)  │
             └──────────┬──────────┘
                        │ request-scoped, read-only
             ┌──────────┴──────────┐
             │ Registered roots    │
             │ A   B   C   ...     │
             └──────────▲──────────┘
                        │ edit / shell / git / test
             ┌──────────┴──────────┐
             │  Codex Harness      │
             └─────────────────────┘
```

## Principles

- **ChatGPT thinks. Codex works.** The bridge never re-implements a coding harness.
- **Computer Use = control plane**: tiny `[C2C]` state messages (< 1 KB).
- **MCP = data plane**: ChatGPT pulls files/diffs/search results itself.
- **Read-only by design**: no write/exec tools exist in V1 at all.
- **Workspace is the read boundary**: one installation bridge owns a registered allowlist, and every workspace-dependent MCP call resolves one target by id/alias (or the persisted default). The installation has one stable identity and one owner lock; there is no mutable current workspace.

## Components (src/)

| Module | Responsibility |
| --- | --- |
| `bridge/` | Express app assembly, loopback-only listener, port fallback, runtime state, admin API |
| `mcp/` | McpServer with workspace-aware read-only tools plus installation discovery; stateless Streamable HTTP transport (fresh server per request, JSON responses) |
| `auth/` | OAuth 2.1 authorization server: discovery metadata (RFC 8414 + Protected Resource Metadata), dynamic client registration (RFC 7591), authorization-code + PKCE (S256 only), refresh rotation, revocation (RFC 7009). Opaque tokens stored as SHA-256 hashes |
| `pairing/` | PairingCode lifecycle: CSPRNG generation, TTL, attempt limits, IP rate limit, one-time use |
| `workspace/` | Canonical-path containment, sensitive-file policy, `.c2cignore`, paginated read/list, search/git, and the installation workspace registry |
| `tunnel/` | Installation-owned `TunnelProvider` interface + Cloudflare Quick/Named and official OpenAI `tunnel-client` integration; one canonical installation tunnel state |
| `execution/` | JSONL execution records plus optional sanitized command output (`execution_output`) |
| `process/` | Daemon spawn/reuse, health probing, graceful shutdown |
| `cli/` | `c2c` commands; `--json` everywhere for the Skill |
| `config/`, `logger/` | OS-convention state dir, secret-redacting logger |

## Request lifecycles

**MCP call**: ChatGPT → one installation tunnel → bridge `/mcp` → bearer
middleware → stateless StreamableHTTP transport → tool handler (including
`list_workspaces`) → registry resolution (id/alias/default, fail closed) → selected workspace layer
(path containment → ignore rules → pagination) → JSON result. No mutable current
workspace is changed by a request.

**Authorization**: 401 with `WWW-Authenticate: resource_metadata=…` →
`/.well-known/oauth-protected-resource/mcp` → AS metadata → DCR →
`/oauth/authorize` (HTML pairing page) → pairing code verified → 302 with
authorization code → `/oauth/token` (PKCE S256) → access + refresh tokens.

**Lifecycle/ports**: prefer 48765, bind 127.0.0.1 only. A state-directory
startup lock serializes check-and-spawn, and the daemon holds an installation
owner lock for its lifetime; a compatible `/health` + runtime/contract/build
identity is reused. A build-mismatched daemon is replaced only after the same-
installation owner lease, process identity, health, and authenticated admin
endpoint all verify; unknown/conflicting owners are never killed or silently
reused.
A non-C2C occupant may still cause the single owner to fall back to an ephemeral
port. Configuration follows via installation runtime state; users never manage
ports. Registering another root updates the allowlist without starting a second
daemon or tunnel. Provider changes validate the candidate first, then serialize
stop-and-state-update in this same installation startup critical section.

**Tunnel**: default is a Cloudflare Quick Tunnel (`cloudflared tunnel --url …`); an installation may instead use the official OpenAI `tunnel-client` with an existing Tunnel ID and runtime `CONTROL_PLANE_API_KEY`. The child receives no `OPENAI_ADMIN_KEY`, and the tunnel-client owner lock plus daemon owner lock prevent two clients sharing one tunnel id/channel.
The Quick Tunnel URL changes per start, so `c2c doctor` can restart it and tell the Skill to
Delete + recreate the installation's ChatGPT connector; an OpenAI tunnel uses its
stable tunnel-id URL. The workspace target never changes that connector. The Skill asks before the first public URL exists;
`cloudflared tunnel login` is the only extra user step. Tunnel name, hostname and preference live in one installation-owned record under the OS state dir, never in the project. Obsolete per-workspace tunnel records are not read. Named starts use `cloudflared tunnel --url … run <name>` so the public
URL stays stable. If named provisioning fails, C2C falls back to Quick Tunnel.
If a named tunnel later drops, doctor asks for a Cloudflare re-login
(`namedRepair`) instead of rotating the one installation connector.
