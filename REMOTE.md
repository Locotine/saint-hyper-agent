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

## 3) Remote SSH hosts

Saint (Stable and Beta) can run a server on another machine and use it from the app window, similar to Orca's remote hosts. Agents, git, and terminals then run on that machine.

Open **Settings → Remote hosts**, enter an alias from `~/.ssh/config` (or `user@host`), and select **Connect**. The desktop app:

1. Opens one shared SSH connection (`ControlMaster`, kept 120 s after its last use; not on Windows) and runs a probe over it with `ssh -o BatchMode=yes` in your login shell to check Node.js, `tar`, and any server already running.
2. If this build is missing, uploads the remote server bundle the app ships (`apps/server/dist/remote`, with every pure-JavaScript dependency inlined, plus the web client). The packages that must stay on disk (`node-pty`, `typescript`, the Claude Agent SDK, `open`, `@xterm/headless`) come from a dependency pack committed in the repository (`apps/server/remote-deps/deps.tar.gz`, about 13 MB): their exact workspace versions with the repository's patches already applied, node-pty from `@lydell/node-pty`, whose prebuilt N-API binaries cover macOS and Linux on arm64 and x64, and without the Claude Code binary bundled with the Agent SDK. The host unpacks it with `tar` once per pack, platform, and Node.js ABI into `deps/` and keeps only its own node-pty binary. No host and no desktop runs npm, `patch`, or a compiler; later builds with the same pack upload and unpack no dependencies at all.
3. Starts `node --max-old-space-size=1024 --max-semi-space-size=8 dist/index.mjs --mode web --host 127.0.0.1 --port <free port>` in the tmux session `<folder name>` (falls back to `nohup` without tmux), with `SAINT_PROVIDERS=codex,claudeAgent`. It also removes installed versions that no server runs (checked with `pgrep`) and dependency folders no remaining version uses.
4. Forwards a local loopback port with `ssh -N -L` (its own connection) and lists the host's projects in the sidebar's **Projects** list, next to this computer's, each labeled with the host and its status. Its chats open in the app window like local ones; the window never switches to the host. A host's projects and threads use the same rows and right-click menus as this computer's (pin, rename, snooze, handoff, fork, archive, delete, nested subagent sessions); Hub actions are left out because a hub links a project on this computer.

Each step is written to `desktop-main.log` (`[remote-ssh] <host> <phase> +<ms>`). **Disconnect** during a step stops its ssh at once, and a timed-out step reports the last stage it reached (for example `Unpacking the dependencies Saint uploaded.`). Killing ssh sends the remote shell no signal, so the next install first stops an earlier install of the same folder that is still running.

To keep a host that many people share light, the remote server releases what it does not use:

| Setting                                                | Effect                                                                                                                                                                                                                            |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SAINT_PROVIDER_RUNTIME_IDLE_STOP_MS=180000`           | An agent's `claude`/`codex` process stops 3 minutes after its last turn (10 minutes on a desktop) and resumes its session on the next message.                                                                                    |
| `SAINT_IDLE_EXIT_MS=600000`                            | The server exits after 10 minutes with no open window, no running turn or provider background task, no terminal running a command or dev server, and no scheduled automation. The next **Connect** starts it again with its data. |
| `--max-old-space-size=1024`, `--max-semi-space-size=8` | Caps the server's JavaScript heap at 1 GB (Node's default is about a quarter of RAM, up to roughly 4 GB) and uses a smaller young generation.                                                                                     |

The remote server listens only on the remote loopback interface. The auth token is generated per start, sent over stdin, and stored in `<folder>/run/token` with mode 0600. It never appears in an ssh or process argument list.

| Action               | Effect                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Disconnect           | Closes the tunnel; the host's rows dim and its open chats turn read-only. The server and its agents keep running until the server is idle. |
| Stop server          | Also stops the remote server. Installed files and data stay.                                                                               |
| Quit Saint           | Closes tunnels only. Chats running on a host keep running there.                                                                           |
| Close the app window | Quits Saint like any other close. Tunnels close and remote servers keep running.                                                           |

Remote layout, relative to the remote home (shared folder `.saint-remote`, `.saint-beta-remote` for Beta):

| Path                                 | Contents                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `versions/<build>/`                  | Server bundle, shared by every desktop and remote folder; `node_modules` links into `deps/` |
| `deps/<hash>-<os>-<arch>-node<abi>/` | Unpacked dependency pack, shared by every version built with the same pack                  |
| `clients/<client-id>/home/`          | `SAINT_HOME` of this desktop's remote server (database, settings, threads)                  |
| `clients/<client-id>/run/`           | `server.sh`, `server.pid`, `server.json`, `token`, `server.log`                             |
| `clients/<client-id>/staging/`       | Upload and unpack in progress; removed when the version is published to `versions/`         |

`<build>` is the app version plus the first 12 hex digits of a SHA-256 of the server bundle (for example `1.0.12-3f2a9c1b7d4e`). A rebuild that keeps the version number therefore installs and starts its own server instead of reusing an older one, and the older install is removed once no server runs it. `<hash>` is the first 12 hex digits of the dependency pack's SHA-256 (recorded in `apps/server/remote-deps/deps.json`), and `<abi>` is `process.versions.modules` of the host's `node`, so upgrading Node.js on the host unpacks the pack again on the next connect.

An administrator can install a build once for every account of a host. Copy a connected account's `versions/<build>` and the `deps/` folder it links to into one read-only folder (for example `cp -R ~/.saint-beta-remote/versions ~/.saint-beta-remote/deps <shared>/`, which keeps the relative links), and set `SAINT_REMOTE_SHARED_STORE=<shared>` (an absolute path) in the environment of every user's login shell. A desktop whose build and Node.js ABI match a version there runs it in place and uploads and installs nothing; otherwise it installs into its own account as usual. Clients never write to or remove from the shared folder, so the administrator removes old builds. Make it writable only by the administrator: every account runs its code.

`<client-id>` is the local user name plus 8 random hex digits (for example `anh-0a1b2c3d`), created once per desktop install and stored in `userdata/remote-ssh-client-id`. Desktops that reach the same remote account therefore run separate servers, with their own data and tmux session, and never see each other's threads. They share only the installed versions; the first to finish installing a version publishes it with one atomic rename and the others reuse it. This separates data per desktop, not per Unix user: anyone with a shell on that remote account can still read every folder.

**Remote folder** in Settings overrides the client folder with one of your own (for example `squad/saint-remote`), for instance to reach the same server from two desktops. A folder used before client folders existed (data directly in `.saint-remote/home`) is left in place; set **Remote folder** to `.saint-remote` to reach it again, or stop its server there once nobody needs it.

The remote server runs only Codex and Claude, through the `codex` and `claude` CLIs on the host's `PATH` (or the binary paths set in **Settings → Providers**). The host's server refuses other providers.

Host requirements: key-based SSH (no password prompts), Node.js 22.16+ (23.11+ on the 23 line, or 24+) and `tar` on the login shell's `PATH`, and tmux (recommended). npm, `patch`, a compiler and registry access are not needed. Install and sign in to `codex` and/or `claude` on the host itself. Windows hosts are not supported yet: the install and start scripts are POSIX `sh`.

The dependency pack changes only when a remote dependency, its patch, or its locked version changes. After such a change, run `bun run remote:deps-pack` on a machine with npm and commit `apps/server/remote-deps/`; `scripts/remote-deps-pack.test.ts` and the desktop artifact build fail while the committed pack is stale (`bun run remote:deps-pack -- --check` reports why).

A host's chat in the app window sends, streams, interrupts and answers approvals and questions through the host's server, and its search results, Activity rows and notifications sit with this computer's. While the host is disconnected its rows are dimmed and a chat that was loaded stays readable but cannot send; one never loaded says the host is offline.

| Action                     | On a remote host                                                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New thread                 | The button on the host's project row creates the thread on the host and opens it.                                                                           |
| Add project                | **Add project** asks **This computer** or a connected host; a host opens an in-app picker that lists its folders and marks git repositories.                |
| Quit Saint                 | The quit dialog lists the host's running chats as "Keeps running on <host>"; only this computer's chats stop or resume.                                     |
| Environment, Explorer, git | Hidden in a host's chat for now: the Environment card, project panels, Open in, git actions, branch toolbar and project scripts would act on this computer. |

These remain limits:

- The browser panel, AppSnap, computer use, terminals and the Explorer stay on this computer.
