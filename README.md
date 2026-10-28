<div align="center">
  <h1>Saint</h1>
  <p><strong>A focused workspace for coding agents.</strong><br>
  Projects, provider sessions, execution surfaces, and review tools in one local-first desktop application.</p>
  <p>
    <a href="https://gitlab.com/locotine/saint-hyper-agent">Source</a>
    &nbsp;·&nbsp;
    <a href="./docs/README.md">Documentation</a>
    &nbsp;·&nbsp;
    <a href="./REMOTE.md">Remote SSH hosts</a>
    &nbsp;·&nbsp;
    <a href="./docs/external-mcp.md">MCP integration</a>
    &nbsp;·&nbsp;
    <a href="https://gitlab.com/locotine/saint-hyper-agent/-/issues">Report an issue</a>
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
| **Antigravity** | Antigravity CLI                             |
| **Grok**        | Grok Build                                  |
| **Droid**       | Factory Droid                               |
| **OpenCode**    | OpenCode and its configured model providers |
| **Pi**          | Pi and its configured model providers       |
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

### 6. Remote SSH hosts

Open a project that lives on another machine in its own window. Saint installs its server on the host over SSH, starts it in tmux, and tunnels the window to it, so agents, Git, terminals, and files run on the host. Remote servers run Codex and Claude with the CLIs installed on the host.

- Connect from **Settings → Remote hosts** with an alias from `~/.ssh/config`
- Browse the host's folders, preview its HTML files, and upload dropped files as attachments
- Create, rename, move, delete, upload, and download files on the host from the Explorer
- Several users of one account can keep separate servers and data that share a single install; an administrator can install a build once for every account
- One shared SSH connection, a bundled server that skips npm after the first install, and idle shutdown keep a shared host light
- A new build installs its own server automatically, even when the version number is unchanged

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

The current release is **1.0.12**. Download it from [GitLab Releases](https://gitlab.com/locotine/saint-releases/-/releases), or build the installer yourself (see [Build installers](#build-installers)). Installed apps update themselves from the same feed.

| Platform              | Artifact                          | Install                                                                                                                                  |
| --------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Linux x86_64          | `Saint-<version>-x86_64.AppImage` | `bash install-saint.sh` (from the same release) installs it with a menu entry and lets the updater replace it; `--uninstall` removes it. |
| Windows x64           | `Saint-<version>-x64.exe`         | Run the NSIS installer. Unsigned builds show a SmartScreen warning.                                                                      |
| macOS (Apple Silicon) | `Saint-<version>-arm64.dmg`       | Open the disk image and drag Saint to Applications. Requires macOS 13 or later. Intel builds are not published; build them on macOS.     |

Saint Beta is retired. To move Beta data into Saint once, quit both apps and run `copy-saint-beta-data.sh` (macOS/Linux) or `copy-saint-beta-data.ps1` (Windows) from the release assets. The Stable data it replaces is kept as a backup. See [CHANGELOG](./CHANGELOG.md) for release notes.

Workspace Git features require [Git 2.29 or newer](https://github.com/git/git/blob/v2.29.0/Documentation/RelNotes/2.29.0.txt). Background refreshes preserve the FETCH_HEAD used by explicit fetch workflows. Ahead/behind counts use local refs and can update on the next status poll, up to 60 seconds after a successful background refresh; status reads do not wait for the remote.

### Provider setup

Saint uses the provider installations and subscriptions already configured on the local machine. Install and authenticate the runtime you intend to use before starting a session. For Codex sessions, follow the [Codex CLI setup](https://github.com/openai/codex).

### Run from source

The development checkout uses [Bun 1.4.4](https://bun.sh/) and [Node.js 24.13.1](https://nodejs.org/).

```console
git clone https://gitlab.com/locotine/saint-hyper-agent.git
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
bun run build:desktop
bun run dist:desktop:linux -- --flavor production --build-version 1.0.12
bun run dist:desktop:win -- --flavor production --build-version 1.0.12
bun run dist:desktop:dmg:arm64 -- --flavor production --build-version 1.0.12   # macOS only
```

`--build-version` defaults to the package version. Set `SAINT_DESKTOP_UPDATE_GITLAB_PROJECT` (and optionally `SAINT_DESKTOP_UPDATE_FEED_URL`) at build time so installed apps update from your GitLab releases project, then publish with `bun run release:gitlab`; see [Updates from a GitLab Releases feed](./BETA.md#updates-from-a-gitlab-releases-feed).

Artifacts land in `release/` (or `SAINT_DESKTOP_OUTPUT_DIR`). The Linux package must be built on Linux x64, because it compiles `node-pty`. The Windows installer builds on Windows or cross-builds on Linux: the cross-build installs the win32 optional packages, uses the prebuilt native bindings instead of compiling them, and needs Wine with 32-bit support (`wine`, `wine64`, `wine32:i386`) for the executable resources and the NSIS uninstaller. See the [release guide](./docs/release.md#building-installers-on-linux).

## Contributing

Bug fixes, reliability improvements, performance work, documentation, and maintenance changes are welcome.

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a merge request. For a reproducible problem, [open an issue](https://gitlab.com/locotine/saint-hyper-agent/-/issues) with the Saint version, operating system, runtime, and relevant logs.

## Maintainer

Saint is maintained by Locotine at [gitlab.com/locotine/saint-hyper-agent](https://gitlab.com/locotine/saint-hyper-agent). Third-party notices are kept in [NOTICE](./NOTICE).

## License

Saint is licensed under the [Apache License 2.0](./LICENSE). It includes software originally released under the MIT License; that notice is kept in [NOTICE](./NOTICE).
