# Remote Access Setup

Use this when you want to open Saint from another device (phone, tablet, another laptop).

## CLI ↔ Env option map

The Saint CLI accepts the following configuration options, available either as CLI flags or environment variables:

| CLI flag                | Env var               | Notes                              |
| ----------------------- | --------------------- | ---------------------------------- |
| `--mode <web\|desktop>` | `SAINT_MODE`          | Runtime mode.                      |
| `--port <number>`       | `SAINT_PORT`          | HTTP/WebSocket port.               |
| `--host <address>`      | `SAINT_HOST`          | Bind interface/address.            |
| `--home-dir <path>`     | `SAINT_HOME`          | Base directory.                    |
| `--dev-url <url>`       | `VITE_DEV_SERVER_URL` | Dev web URL redirect/proxy target. |
| `--no-browser`          | `SAINT_NO_BROWSER`    | Disable auto-open browser.         |
| `--auth-token <token>`  | `SAINT_AUTH_TOKEN`    | WebSocket auth token.              |

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

Saint Beta can run a server on another machine and open it in its own desktop window, similar to Emdash's remote workspaces. Agents, git, and terminals then run on that machine.

Open **Settings → Remote hosts**, enter an alias from `~/.ssh/config` (or `user@host`), and select **Connect**. The desktop app:

1. Runs a probe over `ssh -o BatchMode=yes` in your login shell to check Node.js, npm, and any server already running.
2. If this build is missing, uploads the server bundle the app ships (`apps/server/dist` with the web client), runs `npm install --omit=dev`, and applies the repository's dependency patches with `patch`. The install fails if a patch no longer applies. It leaves out the SDKs of providers the remote server does not run and the Claude Code binary bundled with the Agent SDK.
3. Starts `node dist/index.mjs --mode web --host 127.0.0.1 --port <free port>` in the tmux session `<folder name>` (falls back to `nohup` without tmux), with `SAINT_PROVIDERS=codex,claudeAgent`. It also removes installed versions that no server runs (checked with `pgrep`).
4. Forwards a local loopback port with `ssh -N -L` and opens a window whose backend is that port.

The remote server listens only on the remote loopback interface. The auth token is generated per start, sent over stdin, and stored in `<folder>/run/token` with mode 0600. It never appears in an ssh or process argument list.

| Action      | Effect                                                                            |
| ----------- | --------------------------------------------------------------------------------- |
| Disconnect  | Closes the tunnel and the host's windows. The server and its agents keep running. |
| Stop server | Also stops the remote server. Installed files and data stay.                      |
| Quit Saint  | Closes tunnels only.                                                              |

Remote layout, relative to the remote home (default folder `.saint-remote`, `.saint-beta-remote` for Beta):

| Path                | Contents                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `versions/<build>/` | Server bundle and `node_modules`. Only in the default folder, shared by every remote folder |
| `home/`             | `SAINT_HOME` of the remote server (database, settings)                                      |
| `run/`              | `server.sh`, `server.pid`, `server.json`, `token`, `server.log`                             |
| `staging/`          | Upload and `npm install` in progress; removed when the version is published to `versions/`  |

`<build>` is the app version plus the first 12 hex digits of a SHA-256 of the server bundle (for example `1.0.9-3f2a9c1b7d4e`). A rebuild that keeps the version number therefore installs and starts its own server instead of reusing an older one, and the older install is removed once no server runs it.

On shared accounts, set **Remote folder** to a folder of your own (for example `squad/saint-remote`). Each folder gets its own server, data and tmux session, and all folders run the same installed build from the default folder's `versions/`. The first folder to finish installing a version publishes it with one atomic rename; the others reuse it.

The remote server runs only Codex and Claude, through the `codex` and `claude` CLIs on the host's `PATH` (or the binary paths set in **Settings → Providers**). Other providers are hidden in remote windows, and the server refuses them.

Host requirements: key-based SSH (no password prompts), Node.js 22.16+ (23.11+ on the 23 line, or 24+) and npm on the login shell's `PATH`, `patch`, tmux (recommended), and, on Linux, a C/C++ toolchain and Python for `node-pty`. Install and sign in to `codex` and/or `claude` on the host itself.

In a remote window, paths belong to the host:

| Action                          | Behavior in a remote window                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Browse for a folder             | Opens an in-app picker that lists the host's folders through the server and marks git repositories.                                                                            |
| Open in editor                  | Opens the folder in the local VS Code, VS Code Insiders, Cursor, Windsurf, or VSCodium through `vscode-remote://ssh-remote+<host>`. The editor needs its Remote-SSH extension. |
| Preview an HTML file            | Renders it from the host in a sandboxed frame, with its relative assets and no size limit. The frame cannot read the app, its storage, or the server token.                    |
| Drop files into the composer    | Uploads them as attachments instead of mentioning local paths.                                                                                                                 |
| Drop a folder on "Add project"  | Not available. Browse or type the host path.                                                                                                                                   |
| Reveal in Finder / file manager | Hidden.                                                                                                                                                                        |

These remain limits:

- The browser panel, AppSnap, and computer use stay with the local app window.
- Remote windows share the local window's browser storage, such as UI preferences.
