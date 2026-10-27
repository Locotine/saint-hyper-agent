// FILE: remoteSshScripts.ts
// Purpose: POSIX shell scripts the desktop pipes to a remote host over ssh to install,
//          start, and stop a Saint server there, plus parsers for their reports.
// Layer: Desktop remote SSH utility
// Exports: remote script builders, report parsers, REMOTE_SSH_LOGIN_SHELL_COMMAND

import { REMOTE_SERVER_PROVIDERS, SAINT_PROVIDERS_ENV } from "@saint/shared/serverProviders";

/** Report lines carry this prefix so login-shell banners on stdout never parse as data. */
export const REMOTE_SSH_REPORT_PREFIX = "SAINT_REMOTE ";

/**
 * Remote command that reads a script from stdin inside the user's login shell,
 * so PATH entries from shell profiles (nvm, mise, Homebrew) reach `node`. The
 * outer single quotes keep it valid for non-POSIX login shells such as fish.
 */
export const REMOTE_SSH_LOGIN_SHELL_COMMAND = `sh -c 'exec "\${SHELL:-/bin/sh}" -lc "exec sh -s"'`;

/** Shown when the host's Node.js cannot run the server; mirrors `isRemoteNodeVersionSupported`. */
export const REMOTE_SSH_NODE_REQUIREMENT = "Node.js 22.16+, 23.11+ or 24+";

export interface RemoteSshScriptTarget {
  /** Install folder relative to the remote `$HOME`, already validated. */
  readonly remoteRoot: string;
  /**
   * Folder whose `versions/` holds the installed server versions every install
   * folder shares (the default install folder), relative to `$HOME`.
   */
  readonly storeRoot: string;
  readonly version: string;
}

export interface RemoteSshProbeReport {
  readonly nodeVersion: string | null;
  readonly npm: boolean;
  readonly installed: boolean;
  /** Present when a server from this install folder is alive on the remote. */
  readonly server: {
    readonly port: number;
    readonly version: string;
    readonly token: string;
  } | null;
}

export interface RemoteSshServerReport {
  readonly port: number;
  readonly token: string;
}

export function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function assertSafeVersion(version: string): void {
  if (!/^[0-9A-Za-z.+-]+$/u.test(version)) {
    throw new Error(`Unsupported Saint version for a remote install: ${version}`);
  }
}

function preamble(target: RemoteSshScriptTarget): string {
  assertSafeVersion(target.version);
  return [
    "set -eu",
    `root="$HOME/"${quoteShell(target.remoteRoot)}`,
    `store="$HOME/"${quoteShell(`${target.storeRoot}/versions`)}`,
    `version=${quoteShell(target.version)}`,
    'install_dir="$store/$version"',
    'staging="$root/staging/$version"',
    'run_dir="$root/run"',
    `session=${quoteShell(remoteTmuxSessionName(target.remoteRoot))}`,
    `report() { printf '${REMOTE_SSH_REPORT_PREFIX}%s\\n' "$1"; }`,
  ].join("\n");
}

/** One tmux session per install folder, so Stable, Beta and custom folders never collide. */
export function remoteTmuxSessionName(remoteRoot: string): string {
  return remoteRoot.replace(/^\.+/u, "").replace(/[^A-Za-z0-9_-]+/gu, "-") || "saint-remote";
}

const SERVER_ALIVE_FUNCTION = `server_alive() {
  [ -f "$run_dir/server.pid" ] || return 1
  pid=$(cat "$run_dir/server.pid" 2>/dev/null || true)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}`;

/** Reports node/npm availability, whether this version is installed, and any live server. */
export function buildRemoteProbeScript(target: RemoteSshScriptTarget): string {
  return `${preamble(target)}
${SERVER_ALIVE_FUNCTION}
node_version=$(node --version 2>/dev/null || true)
npm_ok=false
if command -v npm >/dev/null 2>&1; then npm_ok=true; fi
installed=false
if [ -f "$install_dir/.installed" ]; then installed=true; fi
server=null
if server_alive && [ -f "$run_dir/server.json" ] && [ -f "$run_dir/token" ]; then
  server="{\\"info\\":$(cat "$run_dir/server.json"),\\"token\\":\\"$(cat "$run_dir/token")\\"}"
fi
report "{\\"kind\\":\\"probe\\",\\"node\\":\\"$node_version\\",\\"npm\\":$npm_ok,\\"installed\\":$installed,\\"server\\":$server}"
`;
}

/**
 * Shell command that unpacks the gzipped install bundle from stdin into this
 * install folder's own staging folder, so two folders installing at once never
 * share one.
 */
export function buildRemoteUploadCommand(target: RemoteSshScriptTarget): string {
  assertSafeVersion(target.version);
  const staging = `"$HOME/"${quoteShell(`${target.remoteRoot}/staging/${target.version}`)}`;
  return `sh -c ${quoteShell(`set -eu; rm -rf ${staging}; mkdir -p ${staging}; tar -xzf - -C ${staging}`)}`;
}

/**
 * Installs production dependencies with npm, applies the Bun patches listed in
 * `patches/index.tsv` (npm never reads `patchedDependencies`), drops the Claude
 * Code binary the Agent SDK bundles (the server runs the host's `claude`), then
 * publishes the version into the shared store with one atomic rename. A patch
 * that no longer applies fails the install rather than shipping an unpatched
 * runtime.
 */
export function buildRemoteInstallScript(target: RemoteSshScriptTarget): string {
  return `${preamble(target)}
cd "$staging"
if ! npm install --omit=dev --no-audit --no-fund --loglevel=error >npm-install.log 2>&1; then
  tail -n 40 npm-install.log >&2
  exit 1
fi
if [ -f patches/index.tsv ]; then
  tab=$(printf '\\t')
  while IFS="$tab" read -r package file; do
    [ -n "$package" ] || continue
    [ -d "node_modules/$package" ] || continue
    if ! command -v patch >/dev/null 2>&1; then
      echo "The 'patch' command is required to install Saint on this host." >&2
      exit 1
    fi
    if ! patch -p1 --forward --batch --silent -d "node_modules/$package" <"patches/$file" >&2; then
      echo "Could not apply $file to $package." >&2
      exit 1
    fi
  done <patches/index.tsv
fi
rm -rf node_modules/@anthropic-ai/claude-agent-sdk-*
: >.installed
cd "$HOME"
mkdir -p "$store"
# rename(2) never replaces a non-empty folder: when another install folder
# published this version first, keep theirs. A folder without .installed is a
# broken install from an older layout and is replaced.
node -e '
const fs = require("fs");
const [staging, target] = process.argv.slice(1);
try {
  fs.renameSync(staging, target);
} catch {
  if (fs.existsSync(target + "/.installed")) {
    fs.rmSync(staging, { recursive: true, force: true });
  } else {
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
  }
}
' "$staging" "$install_dir"
rmdir "$root/staging" 2>/dev/null || true
report '{"kind":"installed"}'
`;
}

export interface RemoteStartOptions {
  readonly token: string;
  /** Development renderer origin the remote server must trust (Vite dev server). */
  readonly devUrl?: string | undefined;
}

/**
 * Stops any server from this install folder, starts this version on a free
 * loopback port inside tmux (or detached with nohup when tmux is missing),
 * waits for /health, and removes installed versions no server runs. Only the
 * Codex and Claude providers run (`SAINT_PROVIDERS`). The token travels
 * on stdin and lives in a 0600 file, never in a process argument list.
 */
export function buildRemoteStartScript(
  target: RemoteSshScriptTarget,
  options: RemoteStartOptions,
): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(options.token)) {
    throw new Error("Remote auth token must be URL-safe.");
  }
  if (options.devUrl && !/^https?:\/\/[A-Za-z0-9.:[\]/-]+$/u.test(options.devUrl)) {
    throw new Error(`Unsupported development URL for a remote server: ${options.devUrl}`);
  }
  const devUrlFlag = options.devUrl ? ` --dev-url ${options.devUrl}` : "";
  return `${preamble(target)}
${SERVER_ALIVE_FUNCTION}
${stopServerLines()}
mkdir -p "$run_dir" "$root/home"
chmod 700 "$root" "$run_dir"
port=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')
umask 077
printf '%s' ${quoteShell(options.token)} >"$run_dir/token"
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\\\\\''/g")"; }
{
  echo '#!/bin/sh'
  echo "export PATH=$(quote "$PATH")"
  echo "SAINT_AUTH_TOKEN=\\$(cat $(quote "$run_dir/token"))"
  echo 'export SAINT_AUTH_TOKEN'
  echo 'export ${SAINT_PROVIDERS_ENV}=${REMOTE_SERVER_PROVIDERS.join(",")}'
  echo "echo \\$\\$ >$(quote "$run_dir/server.pid")"
  echo "exec node $(quote "$install_dir/dist/index.mjs") --mode web --host 127.0.0.1 --port $port --home-dir $(quote "$root/home") --no-browser${devUrlFlag} >>$(quote "$run_dir/server.log") 2>&1"
} >"$run_dir/server.sh"
printf '{"port":%s,"version":"%s"}' "$port" "$version" >"$run_dir/server.json"
if command -v tmux >/dev/null 2>&1; then
  tmux new-session -d -s "$session" "sh $(quote "$run_dir/server.sh")"
else
  nohup sh "$run_dir/server.sh" </dev/null >/dev/null 2>&1 &
fi
if ! node -e '
const url = "http://127.0.0.1:" + process.argv[1] + "/health";
const deadline = Date.now() + 90000;
const poll = () => fetch(url).then((r) => { if (r.ok) process.exit(0); throw 0; })
  .catch(() => Date.now() > deadline ? process.exit(1) : setTimeout(poll, 500));
poll();
' "$port"; then
  echo "The Saint server did not become ready on the remote host:" >&2
  tail -n 40 "$run_dir/server.log" >&2 2>/dev/null || true
  exit 1
fi
# Other versions go once no server (from any install folder) runs them.
# Without pgrep nothing can be proven unused, so they stay.
in_use() {
  command -v pgrep >/dev/null 2>&1 || return 0
  pgrep -f -- "$1/dist/index.mjs" >/dev/null 2>&1
}
for other in "$store"/*; do
  [ -e "$other" ] || continue
  [ "$other" = "$install_dir" ] && continue
  in_use "$other" || rm -rf "$other"
done
# Folders installed before the shared store kept their own versions.
if [ "$root/versions" != "$store" ]; then rm -rf "$root/versions"; fi
report "{\\"kind\\":\\"started\\",\\"port\\":$port}"
`;
}

function stopServerLines(): string {
  return `if server_alive; then
  kill "$pid" 2>/dev/null || true
  waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 50 ]; do sleep 0.2; waited=$((waited + 1)); done
  kill -9 "$pid" 2>/dev/null || true
fi
if command -v tmux >/dev/null 2>&1; then tmux kill-session -t "$session" 2>/dev/null || true; fi
rm -f "$run_dir/server.pid" "$run_dir/server.json"`;
}

/** Stops the server from this install folder; installed files and data stay. */
export function buildRemoteStopScript(target: RemoteSshScriptTarget): string {
  return `${preamble(target)}
${SERVER_ALIVE_FUNCTION}
${stopServerLines()}
report '{"kind":"stopped"}'
`;
}

function reportLines(stdout: string): unknown[] {
  const reports: unknown[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.startsWith(REMOTE_SSH_REPORT_PREFIX)) continue;
    try {
      reports.push(JSON.parse(line.slice(REMOTE_SSH_REPORT_PREFIX.length)));
    } catch {
      // A malformed report is treated as missing below.
    }
  }
  return reports;
}

function findReport(stdout: string, kind: string): Record<string, unknown> | null {
  for (const report of reportLines(stdout)) {
    if (report && typeof report === "object" && (report as { kind?: unknown }).kind === kind) {
      return report as Record<string, unknown>;
    }
  }
  return null;
}

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536;
}

export function parseRemoteProbeReport(stdout: string): RemoteSshProbeReport | null {
  const report = findReport(stdout, "probe");
  if (!report) return null;
  const node = typeof report.node === "string" && report.node.length > 0 ? report.node : null;
  let server: RemoteSshProbeReport["server"] = null;
  const rawServer = report.server as { info?: unknown; token?: unknown } | null | undefined;
  const info = rawServer?.info as { port?: unknown; version?: unknown } | undefined;
  if (
    info &&
    isPort(info.port) &&
    typeof info.version === "string" &&
    typeof rawServer?.token === "string" &&
    rawServer.token.length > 0
  ) {
    server = { port: info.port, version: info.version, token: rawServer.token };
  }
  return {
    nodeVersion: node,
    npm: report.npm === true,
    installed: report.installed === true,
    server,
  };
}

export function parseRemoteStartReport(stdout: string): { readonly port: number } | null {
  const report = findReport(stdout, "started");
  return report && isPort(report.port) ? { port: report.port } : null;
}

export function hasRemoteReport(stdout: string, kind: "installed" | "stopped"): boolean {
  return findReport(stdout, kind) !== null;
}

/**
 * Whether the server bundle runs on this Node.js. It needs the `node:sqlite`
 * `StatementSync.columns()` API, the same floor the server enforces at startup
 * (apps/server/src/persistence/NodeSqliteClient.ts): 22.16, 23.11, or 24.
 */
export function isRemoteNodeVersionSupported(nodeVersion: string | null): boolean {
  const match = nodeVersion ? /^v?(\d+)\.(\d+)\./u.exec(nodeVersion) : null;
  if (!match?.[1] || !match[2]) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major === 22 && minor >= 16) || (major === 23 && minor >= 11) || major >= 24;
}
