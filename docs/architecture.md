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

- **CLI first.** `c2c` is the primary interface; the Skill is an optional caller.
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
| `auth/` | Secure process-bearer verification; Pairing-only OAuth 2.1 authorization server: discovery metadata (RFC 8414 + Protected Resource Metadata), dynamic client registration (RFC 7591), authorization-code + PKCE (S256 only), refresh rotation, revocation (RFC 7009). Opaque tokens stored as SHA-256 hashes |
| `pairing/` | PairingCode lifecycle: CSPRNG generation, TTL, attempt limits, IP rate limit, one-time use |
| `workspace/` | Canonical-path containment, sensitive-file policy, `.c2cignore`, paginated read/list, search/git, and the installation workspace registry |
| `tunnel/` | Installation-owned `TunnelProvider` interface + Cloudflare Quick/Named and official OpenAI `tunnel-client` integration; one canonical installation tunnel state |
| `execution/` | JSONL execution records plus optional sanitized command output (`execution_output`) |
| `process/` | Daemon spawn/reuse, health probing, graceful shutdown |
| `cli/` | `c2c` management commands, stable JSON status, connection profiles, positional workspace registration, localized help/output |
| `config/`, `logger/` | OS-convention state dir, secret-redacting logger |

## Request lifecycles

**MCP call**: ChatGPT → one installation tunnel → bridge `/mcp` → bearer
middleware → stateless StreamableHTTP transport → tool handler (including
`list_workspaces`) → registry resolution (id/alias/default, fail closed) → selected workspace layer
(path containment → ignore rules → pagination) → JSON result. No mutable current
workspace is changed by a request.

**Secure authorization**: ChatGPT → OpenAI Tunnel → installation-owned
`tunnel-client` → process-bound bearer on local `/mcp`. OAuth and pairing routes
are disabled, and legacy OAuth tokens cannot authenticate in this profile.

**Pairing authorization**: 401 with `WWW-Authenticate: resource_metadata=…` →
`/.well-known/oauth-protected-resource/mcp` → AS metadata → DCR →
`/oauth/authorize` (HTML pairing page) → pairing code verified → 302 with
authorization code → `/oauth/token` (PKCE S256) → access + refresh tokens.

**Lifecycle/ports**: prefer 48765, bind 127.0.0.1 only. A state-directory
startup lock serializes check-and-spawn, and the daemon holds an installation
owner lock for its lifetime. A compatible `/health` response plus verified
installation, process, and runtime-contract identity is reusable across builds;
an explicit restart replaces an older build only after the owner lease, process
identity, health, and authenticated admin endpoint all verify. Unknown or
conflicting owners are never killed or silently reused.
A non-C2C occupant may still cause the single owner to fall back to an ephemeral
port. Configuration follows via installation runtime state; users never manage
ports. Registering another root updates the allowlist without starting a second
daemon or tunnel. Provider changes validate the candidate first, then serialize
stop-and-state-update in this same installation startup critical section.

**Connection profiles**: unconfigured installations default to OpenAI Secure
Tunnel with an existing Tunnel ID, runtime `CONTROL_PLANE_API_KEY`, and official
`tunnel-client`. Missing configuration fails closed, never falls back to Pairing.
Explicit persisted `quick`, `named`, and `openai` choices remain supported.
`c2c connection use secure|pairing` changes the installation-wide profile; Pairing
uses Cloudflare Quick/Named transport plus OAuth. A failed named candidate leaves
the current profile unchanged. Setup never creates a pairing code; `c2c pair`
requires Pairing mode and a running Bridge.

The child receives no `OPENAI_ADMIN_KEY`; tunnel-client and daemon owner locks
prevent overlapping clients. Secure uses a stable Tunnel-ID URL. Quick Pairing
URLs can change, so doctor reports when the installation connector must be
replaced. Named transport keeps a fixed hostname and uses `namedRepair` for
Cloudflare login. Workspace selection never changes a connector or tunnel.
Public startup/repair refuses a mismatched provider or older Bridge build until
an explicit restart. Preferences and tunnel metadata live in the OS state dir,
never the project; obsolete per-workspace tunnel records are not read.

**Language**: installation preferences default to English independently of OS
locale. `prefs set --language en|zh-TW` localizes CLI help/prompts and Pairing HTML.
JSON field names, option names, protocol enums, and error codes remain stable.
