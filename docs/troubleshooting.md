# Troubleshooting

First move, always:

```
c2c doctor
```

It checks Node, workspace, bridge, MCP, OAuth and tunnel — and repairs what it
can (restarts the bridge, restarts the tunnel) without asking.

## Common situations

### "Bridge 未运行"
`c2c start` (or let doctor do it). Bridge logs:
`c2c logs`, or verbose: `c2c logs --verbose`.

If doctor says the bridge state is **uncertain** (无法确认), do not start a
second bridge and do not Delete the ChatGPT connector. Wait and run doctor
again. The local process may still be running.

### Everything was quit and ChatGPT can no longer connect
Quitting Codex / the terminal stops the public address. The next `c2c doctor`
starts a new address and sets `chatgptRepair.needed`. The Skill should tell the
user that the old address expired, then **Delete** the installation
connector (`chatgptRepair.connectorName`) and create it again with the new
address (never click Reconnect — the old URL is dead). Registered workspaces
reuse this one connector and can stay available at the same time.

Mint the pairing code only when the ChatGPT Authorize form is on screen
(`c2c pair`). After the connector is recreated, doctor being green is not
enough: the saved ChatGPT conversation must pass `workspace_info` again. If
that old chat still cannot read the workspace, open a new chat in the same
Project (or switch long-chat) and continue there.

Fixed ChatGPT pages for first-time setup and later repair (do not hunt the UI):

- Developer mode: https://chatgpt.com/#settings/Security
- Plugins hub (manage existing connectors): https://chatgpt.com/plugins
- Add a connector:
  https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins

### Tunnel URL unreachable / ChatGPT says the connector is broken
Same as above: `c2c doctor`, then Delete + recreate the installation
connector if `chatgptRepair.needed`. Mint a pairing code with `c2c pair` only
when the Authorize form is on screen.
If this workspace uses a stable hostname, doctor sets `namedRepair` instead —
re-login to Cloudflare (`c2c tunnel login`) and doctor again. Do not Delete
the connector; the address did not change.

### I have a Cloudflare domain and want a stable hostname
During first-time setup (or the next coding session, once), say you have a
Cloudflare account and give the domain. Codex opens a browser for Cloudflare
login, then keeps `c2c-<project>.your-domain.com`. To stay on the temporary
address, say you do not have a domain. Switching later: tell Codex you want
the stable hostname; it runs `c2c tunnel choose --mode named --zone <domain>`.

### "配对码无效/过期"
Pairing codes are one-time and expire after ~5 minutes. Generate one only
when the ChatGPT Authorize page is ready:

```
c2c pair
```

Older codes become invalid immediately. Do not mint a code during `c2c doctor`.

### Temporary address keeps dropping on a UDP-filtered network
cloudflared defaults to QUIC. If the tunnel reconnects over and over on a
corporate network, set `C2C_TUNNEL_PROTOCOL=http2` and restart the bridge.
Leave it unset to keep cloudflared's default.

### ChatGPT gets 401 on every tool call
The access token expired and refresh failed (e.g. after `c2c unpair` or a
long offline period). Delete the installation connector if the address also changed; otherwise run
Authorize again in ChatGPT and enter a fresh pairing code. Never use Reconnect
when the public address has been replaced.

### cloudflared is not installed
macOS: `brew install cloudflared`
Windows: `winget install Cloudflare.cloudflared`
Linux: see Cloudflare's package instructions.
The Skill installs this automatically during setup.
If cloudflared is installed in a custom location that is not on `PATH`, set
`C2C_CLOUDFLARED_PATH` to the executable's absolute path before running `c2c`.

### OpenAI Secure Tunnel is not ready
Provision the Tunnel outside C2C, then set only its existing id and runtime key:

```bash
export CONTROL_PLANE_TUNNEL_ID=tunnel_...
export CONTROL_PLANE_API_KEY=...
c2c tunnel choose --mode openai
c2c start --tunnel
```

Install the official `tunnel-client` binary or set `C2C_TUNNEL_CLIENT_PATH`.
C2C does not create/delete OpenAI Tunnel objects and never needs
`OPENAI_ADMIN_KEY`. `c2c doctor` reports `/readyz` failures and safely retries a
single installation-owned client; it does not start a second client for a
second workspace.

### Every new Codex chat “repairs” the connection / cannot write logs
The C2C state directory lives outside the project (macOS:
`~/Library/Application Support/codex-with-chatgpt`; Windows:
`%LOCALAPPDATA%\codex-with-chatgpt`). Codex's default sandbox cannot write
there, so each new chat looks like a health-check failure.

`c2c setup`, `c2c doctor` and `c2c sandbox-allow` add that directory to
`[sandbox_workspace_write].writable_roots` in `~/.codex/config.toml`
(`%USERPROFILE%\.codex\config.toml` on Windows). After that, later chats
do not need elevation.

### Port already in use
Handled automatically: an existing healthy installation bridge serving the
registered workspace is reused; adding another registered root does not start
another bridge or tunnel. If a non-C2C process occupies the preferred port, the
single installation owner picks a free port. If ownership or compatibility is
unknown, C2C reports a conflict instead of killing a PID or starting a second
daemon.

### Reading a file returns ACCESS_DENIED_SENSITIVE_FILE
Working as intended: `.env`, keys, credentials and anything matched by
`.c2cignore` are never readable through ChatGPT. `.env.example` is allowed.

### I cannot see Projects in the ChatGPT sidebar
Hover **Chats** /「聊天」, click the … that appears, and choose
**Organize by project** /「按项目整理」. Then create a project named after
this workspace, with **project-only memory**. Tell Codex「好了」when the
collection page is open (`https://chatgpt.com/g/g-p-…/project`).

### This workspace opened the wrong ChatGPT Project
Do not pick another project by name automatically. Open the collection that
matches this workspace and tell Codex「已找到」, or say you want the old
long-chat instead. Each workspace may have its own Project/conversation, but all registered
workspaces use the installation connector.

### Completely stuck
If `c2c status --json` reports a healthy or stopped installation:

```bash
c2c stop
c2c setup
```

This recreates the bridge, tunnel and pairing session from scratch. If it
reports `unknown`/`conflicting`, do not kill the reported PID: inspect
`c2c logs --verbose` and repair the ownership/compatibility conflict first.
Existing authorizations stay valid unless you also ran `c2c unpair`.
