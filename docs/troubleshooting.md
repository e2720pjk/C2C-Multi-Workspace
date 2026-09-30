# Troubleshooting

Start with `c2c connection status`, then `c2c doctor`. Doctor diagnoses the
workspace, sandbox, installation Bridge, MCP authorization, and selected
connection. It repairs supported failures but never silently changes profiles
or takes over an unverified process. `--no-fix` diagnoses without repairing;
JSON failures also return a nonzero exit status.

## Secure Tunnel is not configured

Secure Tunnel is the default for an unconfigured installation. Obtain an
existing OpenAI Tunnel and Runtime API Key outside C2C, then prepare the local
runtime environment:

```bash
export CONTROL_PLANE_TUNNEL_ID=tunnel_...
export CONTROL_PLANE_API_KEY=...
c2c setup
```

Install the official client (macOS: `brew install openai/tools/tunnel-client`)
or set `C2C_TUNNEL_CLIENT_PATH` to its executable. Do not put the key in argv,
project files, or a chat. C2C never needs `OPENAI_ADMIN_KEY` and does not manage
Tunnel resources. Restart C2C after changing the daemon's runtime credentials.

Missing configuration or `/readyz` failures do not enable Pairing. If you want
that alternative, select it explicitly with `c2c connection use pairing`.

## Bridge stopped, uncertain, or outdated

```bash
c2c start
c2c logs --verbose
```

The installation daemon is detached from the initiating terminal. Closing a
terminal is not a reliable way to stop it; use `c2c stop`. After a machine
restart, Secure Tunnel keeps its Tunnel-ID URL, while Quick Pairing may receive
a new address.

For `BRIDGE_UPDATE_REQUIRED` or `CONNECTION_PROFILE_MISMATCH`, use `c2c restart`
after checking the selected profile's prerequisites. Local-only development
uses `start --no-tunnel` or `restart --no-tunnel`.

If status reports `unknown`/`conflicting`, do not kill the reported PID, remove
ownership files, or start a second daemon. Inspect the logs and repair the
ownership/compatibility conflict first. Never delete state while an old daemon
or tunnel-client might still be running.

## Pairing mode and code problems

Pairing is the explicit Cloudflare + OAuth profile:

```bash
c2c connection use pairing
c2c setup
# Only after ChatGPT opens the OAuth authorization form:
c2c pair
```

`PAIRING_DISABLED` means the selected profile is Secure; it does not use codes.
Pairing codes expire after five minutes, are single-use, and become invalid
immediately when a newer code is generated. Setup and doctor never pre-mint one.

`c2c unpair` revokes OAuth access for **all** registered workspaces. To stop a
Secure connection use `c2c stop`; permanent upstream OpenAI revocation is managed
outside C2C. To remove only one workspace, disable or remove its registration.

## Quick URL changed / connector no longer works

Run doctor. Recreate the installation connector only when
`chatgptRepair.needed` is true **and a new MCP URL is available**. Do not click
Reconnect on a card with a dead URL. Reuse the installation's connector name;
do not create one per workspace.

Secure uses **Connection = Tunnel / Authentication = No authentication**.
Pairing uses its HTTPS MCP URL and **Authentication = OAuth**; generate a code
only after the authorization form is open. After reconnecting, verify
`workspace_info` with the intended workspace id/alias before resuming a task.

ChatGPT setup pages:
- Developer mode: https://chatgpt.com/#settings/Security
- Connectors: https://chatgpt.com/plugins
- Create: https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins

## Cloudflare Named transport

Explicitly select a managed domain:

```bash
c2c connection use pairing --transport named --zone example.com
c2c setup
```

A failed candidate leaves the previous profile unchanged. If doctor reports
`namedRepair.needed`, run `c2c connection login`, then doctor again. Do not
recreate a connector whose address has not changed.

For missing cloudflared: macOS `brew install cloudflared`; Windows
`winget install Cloudflare.cloudflared`; Linux use Cloudflare's package
instructions. Custom installations can use `C2C_CLOUDFLARED_PATH`.
On a UDP-filtered network, try `C2C_TUNNEL_PROTOCOL=http2` and restart.
These settings apply only to Pairing transport, not OpenAI Secure Tunnel.

## 401 from ChatGPT

Secure: check the official client and its process-bound local bearer with
doctor/restart. Do not pair or switch profiles automatically.
Pairing: the OAuth token may be expired or revoked. Re-authorize with a fresh
code; recreate the connector only if its address changed.

## CLI language or workspace path

```bash
c2c prefs set --language en       # default, independent of OS locale
c2c prefs set --language zh-TW
c2c workspace add                # cwd
c2c workspace add /path/to/repo --alias main
```

Do not combine a positional path with the old `-w` option. Select registered
workspaces by id/alias for enable, disable, remove, and set-default operations.
Installation-wide commands do not use a workspace path as an access boundary.

## Codex sandbox cannot write state / logs

Setup and doctor prepare Codex's sandbox allowlist; do not run another
`sandbox-allow` immediately before them. For an independent write failure,
run `c2c sandbox-allow`. It adds the C2C state directory to
`[sandbox_workspace_write].writable_roots` in `~/.codex/config.toml`
(or under `CODEX_HOME`). An EPERM failure still requires permission to retry.

## Port conflicts or sensitive files

A verified installation owner reuses its one daemon, or chooses a free port
when another service occupies the preferred port. Unknown ownership fails
closed; another workspace never starts a second tunnel.

`ACCESS_DENIED_SENSITIVE_FILE` is intentional: credentials, `.env`, keys, and
`.c2cignore` matches are unreadable through ChatGPT. `.env.example` is allowed.
