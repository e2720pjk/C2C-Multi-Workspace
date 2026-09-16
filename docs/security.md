# Security Model

## Trust boundaries

1. **Registered workspace root** is the smallest read authorization boundary.
   One installation bridge serves an explicit registry; every workspace-dependent
   request resolves one enabled id/alias (or the persisted default). OAuth
   authorizes the installation endpoint, while the registry prevents a request
   for A from reading B or an unregistered root.
2. **Workspace content is untrusted.** README, comments, diffs may contain
   prompt injection. Every MCP tool description carries an explicit warning and
   tools never grant capabilities based on file content.
3. **The model never sees long-lived credentials.** Computer Use only ever
   handles the one-time pairing code. OAuth access/refresh tokens travel only
   inside the OAuth redirect/token endpoints between ChatGPT's client and the
   bridge. With OpenAI Secure Tunnel + No authentication, the installation-owned
   tunnel-client receives a separate local bearer that never enters ChatGPT.

## Threat model → mitigations

| Threat | Mitigation |
| --- | --- |
| MCP URL leaks | `/mcp` always requires a valid bearer. Normal connector traffic uses OAuth installation tokens. OpenAI Secure Tunnel uses a separate high-entropy Bridge-runtime bearer injected only into the installation-owned tunnel-client; the external ChatGPT connector remains No authentication. Neither form can add roots to the registry. |
| Pairing code brute force | 8 chars from a 31-char CSPRNG alphabet (~40 bits), 5 attempts per session, per-IP rate limit (10/min), 5-minute TTL, one-time use, session destroyed on limit |
| OAuth CSRF | `state` round-tripped verbatim; authorization requests are server-side records keyed by random ids |
| Code interception | PKCE S256 mandatory (plain rejected); authorization codes are one-time, 5-minute TTL, bound to client + redirect URI |
| OAuth token theft | Opaque high-entropy tokens; stored only as SHA-256 hashes; access tokens live 1 h; refresh tokens rotate on every use (replay of the old one fails); revocation endpoint + `c2c unpair` |
| Workspace traversal | `realpath` canonicalization of the deepest existing ancestor; containment check against the canonical root; case-insensitive comparison on macOS/Windows; rejects `..`, absolute escapes, backslash tricks, null bytes |
| Symlink escape | Canonicalization resolves symlinks before the containment check (file and directory symlinks both covered by tests) |
| Sensitive files | Deny-by-default patterns (.env*, keys, SSH, cloud creds, keychains…) enforced at resolve time — reads, listings, and search all pass through the same gate; `git diff` adds pathspec excludes; `.env.example` allowed |
| Oversized file / diff DoS | read_file caps lines and bytes per response; git_diff paginates by byte offset with hard caps; search caps matches and file sizes |
| Tunnel exposure | Bridge binds 127.0.0.1 only (refuses 0.0.0.0). Cloudflare/public OAuth paths protect `/mcp` with OAuth. OpenAI Secure Tunnel exposes the connector as No authentication but the official tunnel-client injects the private Bridge-runtime bearer into every loopback MCP request. |
| OpenAI local-bearer leakage | The bearer is generated once per Bridge process, held only in memory, passed to tunnel-client through its environment, referenced from argv only as `env:C2C_MCP_AUTHORIZATION`, never persisted, and never logged. A restarted Bridge generates a different bearer. |
| Admin API abuse | Loopback-only + random admin token (0600 runtime file) + requests with proxy headers (`cf-connecting-ip`, `x-forwarded-for`) rejected; unauthenticated probes get 404 |
| Log credential leakage | Logger redacts token prefixes, bearer headers, token-like parameters, and pairing-code-shaped strings before writing; the OpenAI runtime key and local MCP bearer are passed only through the tunnel-client environment and never persisted or put literally in argv |
| OpenAI tunnel ownership | Installation owner lock and tunnel-client owner lock permit one verified process per installation; PID/process identity is verified before termination; unverifiable orphan state fails closed |
| OpenAI tunnel administration | C2C accepts an existing Tunnel ID plus runtime `CONTROL_PLANE_API_KEY`; it never accepts or requires `OPENAI_ADMIN_KEY`, tunnel CRUD, or organization administration |
| Execution output leak | Codex may nominate test/build/lint logs; a local sanitizer redacts tokens, pairing-code-shaped strings and home paths, truncates size, and refuses private-key blocks entirely. Restricted items are listed without a body. ChatGPT still cannot run commands. |
| Checkpoint / resume dump | Session checkpoints store short protocol fields only (capped). Resume uses the existing chat or HANDOFF — no new protocol state, no log paste, no re-pairing. |

## Token & scope design

OAuth scopes: `workspace.read`, `workspace.search`, `git.read`, `execution.read`,
`offline_access`. Tools enforce scopes individually (`INSUFFICIENT_SCOPE`). OAuth
access tokens live 1 hour. Refresh tokens live 30 days and rotate. Multi-workspace
installation OAuth tokens are bound to the installation and `client_id`; the
selected workspace is still required to be in the registered, enabled allowlist.
The installation OAuth store is canonical; no legacy tunnel or workspace-state
migration is attempted.

OpenAI Secure Tunnel uses a separate internal bearer for the loopback
`tunnel-client → Bridge` hop. It receives the non-offline MCP scopes, exists for
the lifetime of one Bridge process, and is not an OAuth credential. There is no
periodic token rotation or timer-driven tunnel-client replacement. Unexpected
`tunnel-client` recovery reuses the same still-live Bridge credential; restarting
the Bridge creates a new one.

## Storage

State lives under the OS-convention app dir
(`~/Library/Application Support/codex-with-chatgpt` on macOS), directories 0700,
files 0600. The registered workspace collection/default, installation OAuth,
runtime, endpoint, and tunnel metadata live there — never in a project. Only
canonical installation state is read by the lifecycle; obsolete state fails
closed or is ignored when it is outside the active source of truth. Only SHA-256
hashes of OAuth tokens are persisted — a stolen state file does not yield usable
OAuth bearer tokens. The OpenAI tunnel's internal Bridge-runtime bearer is not
persisted at all.

**V1 limitation**: client registrations and OAuth token hashes are file-based
rather than OS-keychain-based. Raw OAuth tokens are never written anywhere.
Keychain integration is a V2 item.

## What ChatGPT can never do (V1)

Write files, delete files, run shell commands, commit, install packages —
these tools do not exist on the server, so no prompt injection, scope bug, or
UI confusion can enable them.
