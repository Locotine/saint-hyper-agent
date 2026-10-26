# Remote Access Setup

Use this when you want to open Synara from another device (phone, tablet, another laptop).

## CLI ↔ Env option map

The Synara CLI accepts the following configuration options, available either as CLI flags or environment variables:

| CLI flag                | Env var               | Notes                              |
| ----------------------- | --------------------- | ---------------------------------- |
| `--mode <web\|desktop>` | `SYNARA_MODE`         | Runtime mode.                      |
| `--port <number>`       | `SYNARA_PORT`         | HTTP/WebSocket port.               |
| `--host <address>`      | `SYNARA_HOST`         | Bind interface/address.            |
| `--home-dir <path>`     | `SYNARA_HOME`         | Base directory.                    |
| `--dev-url <url>`       | `VITE_DEV_SERVER_URL` | Dev web URL redirect/proxy target. |
| `--no-browser`          | `SYNARA_NO_BROWSER`   | Disable auto-open browser.         |
| `--auth-token <token>`  | `SYNARA_AUTH_TOKEN`   | WebSocket auth token.              |

> TIP: Use the `--help` flag to see all available options and their descriptions.

## Security First

- Always set `--auth-token` before exposing the server outside localhost.
- Treat the token like a password.
- Prefer binding to trusted interfaces (LAN IP or Tailnet IP) instead of opening all interfaces unless needed.

## 1) Build + run server for remote access

Remote access should use the built web app (not local Vite redirect mode).

```bash
bun run build
TOKEN="$(openssl rand -hex 24)"
bun run --cwd apps/server start -- --host 0.0.0.0 --port 3773 --auth-token "$TOKEN" --no-browser
```

Then open on your phone:

`http://<your-machine-ip>:3773`

Example:

`http://192.168.1.42:3773`

Notes:

- `--host 0.0.0.0` listens on all IPv4 interfaces.
- `--no-browser` prevents local auto-open, which is usually better for headless/remote sessions.
- Ensure your OS firewall allows inbound TCP on the selected port.

## 2) Tailnet / Tailscale access

If you use Tailscale, you can bind directly to your Tailnet address.

```bash
TAILNET_IP="$(tailscale ip -4)"
TOKEN="$(openssl rand -hex 24)"
bun run --cwd apps/server start -- --host "$(tailscale ip -4)" --port 3773 --auth-token "$TOKEN" --no-browser
```

Open from any device in your tailnet:

`http://<tailnet-ip>:3773`

You can also bind `--host 0.0.0.0` and connect through the Tailnet IP, but binding directly to the Tailnet IP limits exposure.

## 3) Remote SSH hosts (Beta)

Synara Beta can run a server on another machine and open it in its own desktop window, similar to Emdash's remote workspaces. Agents, git, and terminals then run on that machine.

Open **Settings → Remote hosts**, enter an alias from `~/.ssh/config` (or `user@host`), and select **Connect**. The desktop app:

1. Runs a probe over `ssh -o BatchMode=yes` in your login shell to check Node.js, npm, and any server already running.
2. If this version is missing, uploads the server bundle the app ships (`apps/server/dist` with the web client), runs `npm install --omit=dev`, and applies the repository's dependency patches with `patch`. The install fails if a patch no longer applies.
3. Starts `node dist/index.mjs --mode web --host 127.0.0.1 --port <free port>` in the tmux session `<folder name>` (falls back to `nohup` without tmux). It also removes other installed versions.
4. Forwards a local loopback port with `ssh -N -L` and opens a window whose backend is that port.

The remote server listens only on the remote loopback interface. The auth token is generated per start, sent over stdin, and stored in `<folder>/run/token` with mode 0600. It never appears in an ssh or process argument list.

| Action      | Effect                                                                            |
| ----------- | --------------------------------------------------------------------------------- |
| Disconnect  | Closes the tunnel and the host's windows. The server and its agents keep running. |
| Stop server | Also stops the remote server. Installed files and data stay.                      |
| Quit Synara | Closes tunnels only.                                                              |

Remote layout, relative to the remote home (default folder `.synara-remote`, `.synara-beta-remote` for Beta):

| Path                  | Contents                                                        |
| --------------------- | --------------------------------------------------------------- |
| `versions/<version>/` | Server bundle and `node_modules`                                |
| `home/`               | `SYNARA_HOME` of the remote server (database, settings)         |
| `run/`                | `server.sh`, `server.pid`, `server.json`, `token`, `server.log` |

On shared accounts, set **Remote folder** to a folder of your own (for example `squad/synara-remote`). Each folder gets its own server and tmux session.

Host requirements: key-based SSH (no password prompts), Node.js 24+ and npm on the login shell's `PATH`, `patch`, tmux (recommended), and, on Linux, a C/C++ toolchain and Python for `node-pty`. Sign in to provider CLIs on the host itself.

Remote windows have these limits:

- The folder picker returns nothing. Type the remote path when adding a project.
- The browser panel, AppSnap, and computer use stay with the local app window.
- Remote windows share the local window's browser storage, such as UI preferences.
