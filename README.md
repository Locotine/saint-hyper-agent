<div align="center">
  <h1>Saint Hyper Agent</h1>
  <p><strong>A focused workspace for coding agents.</strong><br>
  Projects, provider sessions, execution surfaces, Remote SSH hosts, and security/review tools in one local-first desktop application.</p>
  <p>
    <a href="https://github.com/Locotine/saint-hyper-agent">Source</a>
    &nbsp;·&nbsp;
    <a href="./docs/README.md">Documentation</a>
    &nbsp;·&nbsp;
    <a href="./REMOTE.md">Remote SSH hosts</a>
    &nbsp;·&nbsp;
    <a href="./docs/external-mcp.md">MCP integration</a>
    &nbsp;·&nbsp;
    <a href="./CHANGELOG.md">Release history</a>
    &nbsp;·&nbsp;
    <a href="https://github.com/Locotine/saint-hyper-agent/issues">Report an issue</a>
  </p>
</div>

<details open>
  <summary><strong>Table of contents</strong></summary>

| Workspace layer      | Responsibility                                                |
| -------------------- | ------------------------------------------------------------- |
| **Project**          | Repository context, settings, and related work.               |
| **Thread**           | Task-specific conversation, state, files, and history.        |
| **Provider session** | The authenticated coding-agent runtime executing the task.    |
| **Workspace tools**  | Changes, terminal, browser, files, editor, previews, and Git. |

> [!NOTE]
> Saint is early-stage software. APIs and interface details remain under active development.

## Capabilities

### 1. Projects, threads, and context

Organize work around projects and threads. Projects define the workspace; threads preserve the task-specific conversation, state, files, and history.

- Project-aware navigation and conversations
- Provider and model selection per task
- Thread history, status, recaps, notes, and side chats
- Search and quick access across active work

### 2. Integrated workspace tools

The tools surrounding an agent session remain available from the same task surface, keeping execution and review connected.

| Surface            | Purpose                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| **Changes**        | Inspect diffs, changed files, and review state.                                                   |
| **Terminal**       | Run commands in the project environment.                                                          |
| **Browser**        | Keep local previews next to the thread and let agents use semantic or page-declared WebMCP tools. |
| **Files / Editor** | Browse, inspect, and edit project files in context. HTML files render in a sandboxed preview.     |
| **Git**            | Work with branches, commits, pushes, and pull requests.                                           |

### 3. Split views and previews

Keep an active conversation alongside the surface it is changing. Split views, browser previews, and device previews make the result part of the working context.

### 4. Provider-native integrations

Saint connects to coding-agent runtimes that are installed and authenticated locally. The current development build includes the following integrations:

| Runtime         | Local integration                           |
| --------------- | ------------------------------------------- |
| **Codex**       | Codex CLI / app-server                      |
| **Claude**      | Claude Code                                 |
| **Cursor**      | Cursor agent runtime                        |
| **Antigravity** | Antigravity CLI (`agy`) over ACP            |
| **Grok**        | Grok Build                                  |
| **Droid**       | Factory Droid                               |
| **OpenCode**    | OpenCode and its configured model providers |
| **Pi**          | Pi and its configured model providers       |
| **Oh My Pi**    | Oh My Pi (`omp`) CLI                        |
| **Devin**       | Devin CLI                                   |

### 5. Isolated parallel work and handoffs

Managed worktrees provide a boundary for parallel changes. Handoffs preserve project context when a task needs to continue with another provider or toolchain.

- Run work in a local checkout or an isolated managed worktree
- Keep parallel threads from modifying the same checkout unintentionally
- Hand off a task without losing its project context
- Review the resulting diff before it leaves the workspace

| Handoff                           | What the next agent receives                                                                                                                                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Same thread / new thread**      | The conversation's messages plus a bounded summary of the earlier session.                                                                                                                                                                    |
| **Fresh session from transcript** | A new thread with an empty history and one prompt: the path of the original Claude or Codex session transcript, the working directory and branch, and the last request and update. The agent reads only the parts of the transcript it needs. |

Start a transcript handoff from the thread header's handoff menu (**Fresh session from transcript**) or from the sidebar's **Handoff** submenu (**<Provider>, fresh from transcript**).

### 6. Remote SSH hosts & Mobile LAN relay

Open a project that lives on another machine directly inside Saint Hyper Agent, including split views and SSH-forwarded dev server previews. Saint installs a prebuilt server bundle over SSH (requiring only Node.js 22.16+ / 23.11+ / 24+, `tar`, and optional `tmux` — no `npm`, C/C++ compiler, or Python needed), runs it on the host, and tunnels sessions so agents, Git, terminals, and files run remotely. Remote servers run Codex and Claude with the CLIs installed on the host.

- Connect from **Settings → Remote hosts** with an alias from `~/.ssh/config`
- Pair mobile or secondary browsers via **Settings → Remote hosts → Mobile & LAN access** (interface-scoped LAN / Tailscale relay with QR pairing)
- Browse host folders, preview HTML/images (with offline placeholders and automatic reload on reconnect), and upload or download files from the Explorer
- Keep multiple desktops cleanly isolated on a shared remote host while reusing one verified bundle install
- Automatic backoff reconnection when tunnels drop or streams stall; explicit Disconnect and Stop server suppress auto-reconnect

See [Remote access](./REMOTE.md) for requirements, the remote layout, and what stays local.

### 7. Automations and external MCP

Automations support recurring agent runs and keep their outcomes attached to projects and threads. External MCP integrations provide scoped, user-approved access for other local clients.

See [External MCP integrations](./docs/external-mcp.md) for setup, pairing, project access, and permission boundaries.

### 8. Appearance and workspace preferences

Configure the shell to match the way you work with light and dark themes, typography controls, density preferences, and workspace settings.

### Additional capabilities

| Workflow          | Included surfaces                                               |
| ----------------- | --------------------------------------------------------------- |
| **Workspace**     | Local projects, chats, history, and multiple provider runtimes. |
| **Execution**     | Terminals, browser previews, files, and editor.                 |
| **Delivery**      | Diffs, Git actions, managed worktrees, and pull requests.       |
| **Orchestration** | Provider handoffs, automations, and scoped external MCP.        |
| **Remote**        | SSH hosts in their own windows, browser access over a token.    |
| **Development**   | Desktop shell plus focused server and web modes.                |

## Installation

### Desktop application

The latest release is **1.2.17** (see [CHANGELOG](./CHANGELOG.md) for full release history). Download it from [GitHub Releases](https://github.com/Locotine/saint-hyper-agent/releases), or build the installer yourself (see [Build installers](#build-installers)). Installed apps update themselves from the same feed.

| Platform              | Artifact                                     | Install                                                                                                      |
| --------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Linux x86_64          | `Saint-Hyper-Agent_<version>_amd64.AppImage` | Make it executable and run it.                                                                               |
| Ubuntu/Debian x86_64  | `Saint-Hyper-Agent_<version>_amd64.deb`      | `sudo apt install ./Saint-Hyper-Agent_<version>_amd64.deb`. Supports Ubuntu 22.04+/24.04+ and Debian 12/13+. |
| Windows x64           | `Saint-Hyper-Agent_<version>_x64-setup.exe`  | Run the NSIS installer. Unsigned builds show a SmartScreen warning.                                          |
| macOS (Apple Silicon) | `Saint-Hyper-Agent_<version>_aarch64.dmg`    | Open the disk image and drag Saint Hyper Agent to Applications. Requires macOS 13 or later.                  |
| macOS (Intel)         | `Saint-Hyper-Agent_<version>_x64.dmg`        | Same as Apple Silicon.                                                                                       |

The Debian package is named `saint-hyper-agent`. Builds up to 1.2.9 were packaged as `saint`, which clashes with Debian's unrelated `saint` package (2.5.0), so system updates replaced the app; the new package replaces and removes the old `saint` 1.x package on install.

The desktop app is built with Tauri (`apps/desktop-rust`). The Electron app is retired from 1.2.1 and its source has been removed from this repository, and Electron installs up to 1.1.17 do not update to the Tauri app on their own. Quit the Electron app, then install the Tauri build from GitHub Releases. Threads, projects and server settings in `~/.saint` carry over; UI state kept in the Electron window (pinned items, open tabs, composer drafts) does not.

macOS builds are not notarized yet. If macOS refuses to open Saint Hyper Agent, choose **System Settings → Privacy & Security → Open Anyway**, or run `xattr -dr com.apple.quarantine "/Applications/Saint Hyper Agent.app"` once (`/Applications/Saint.app` for builds before the rename).

All previously Beta features (Remote SSH, native editor, MCP connectors, Groups, Tasks, and audio trail) ship in Stable; Saint Beta is retired. See [CHANGELOG](./CHANGELOG.md) for release notes and [docs/qa-audit-2026-11.md](./docs/qa-audit-2026-11.md) for the latest full-repo QA audit report.

Workspace Git features require [Git 2.29 or newer](https://github.com/git/git/blob/v2.29.0/Documentation/RelNotes/2.29.0.txt). Background refreshes preserve the FETCH_HEAD used by explicit fetch workflows. Ahead/behind counts use local refs and can update on the next status poll, up to 60 seconds after a successful background refresh; status reads do not wait for the remote.

### Provider setup

Saint uses the provider installations and subscriptions already configured on the local machine. Install and authenticate the runtime you intend to use before starting a session. For Codex sessions, follow the [Codex CLI setup](https://github.com/openai/codex).

### Run from source

The development checkout uses [Bun 1.4.4](https://bun.sh/) and [Node.js 24.13.1](https://nodejs.org/).

```console
git clone https://github.com/Locotine/saint-hyper-agent.git
cd saint-hyper-agent
bun install
bun run dev
```

`bun run typecheck` checks all seven workspaces with TypeScript 7 and the native
Effect checker. CI and each workspace's `typecheck` script use the same compiler.
`bun run typecheck:native` remains an alias for the default check.

The native Effect checker does not enforce every legacy rule: in particular,
`importFromBarrel` errors are currently missed. `bun run typecheck:legacy` keeps
the TypeScript 5 check available for explicit comparisons; it is not run by CI.
The existing compiler also remains installed for build and declaration tools
that require its JavaScript API. Native and legacy checks use separate caches.

Use these named scripts rather than a bare `tsc`, whose version depends on the
current directory. Normal installation patches the native compiler for Effect;
the root `typecheck` command also ensures that patch is applied before checking.

### Build installers

```console
bun install --frozen-lockfile
cd apps/desktop-rust
bun run build:sidecar
bunx @tauri-apps/cli@^2.4.0 build
```

Tauri builds for the current platform; run the build on each target OS. Releases are published by the `Release Desktop (Tauri Rust)` GitHub Actions workflow (`.github/workflows/release-tauri.yml`) when a `vX.Y.Z` tag is pushed, or by dispatching it with `publish_release=true`. It builds Windows, macOS (arm64 and x64) and Linux bundles and uploads them with the `latest.json` updater manifest.

## Contributing

Bug fixes, reliability improvements, performance work, documentation, and maintenance changes are welcome.

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request. For a reproducible problem, [open an issue](https://github.com/Locotine/saint-hyper-agent/issues) with the Saint version, operating system, runtime, and relevant logs.

## Maintainer

Saint is maintained by Locotine at [github.com/Locotine/saint-hyper-agent](https://github.com/Locotine/saint-hyper-agent). Third-party notices are kept in [NOTICE](./NOTICE).

## License

Saint is licensed under the [Apache License 2.0](./LICENSE). It includes software originally released under the MIT License; that notice is kept in [NOTICE](./NOTICE).
