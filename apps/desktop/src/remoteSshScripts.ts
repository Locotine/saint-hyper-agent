// FILE: remoteSshScripts.ts
// Purpose: POSIX shell scripts the desktop pipes to a remote host over ssh to install,
//          start, and stop a Saint server there, plus parsers for their reports.
// Layer: Desktop remote SSH utility
// Exports: remote script builders, report parsers, REMOTE_SSH_LOGIN_SHELL_COMMAND

import { CLIENT_SCOPED_ENV } from "@saint/shared/remoteClientId";
import { REMOTE_TREE_HASH_SCRIPT } from "@saint/shared/remoteTreeHash";
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
  /**
   * Hash of the dependency pack (see `remoteInstallDepsHash`). With the host's
   * platform and Node ABI it names the `deps/` folder versions share.
   */
  readonly depsHash: string;
  /**
   * Hash of the bundle files this build ships and, per `<platform>-<arch>`, of the unpacked
   * dependency pack (see `REMOTE_TREE_HASH_SCRIPT`). With both, a version one account installed
   * into the machine-wide store is reused by every account whose files hash to these, and the
   * first account to need a version publishes it there. Without them every account keeps its own.
   */
  readonly bundleTree?: string | undefined;
  readonly depsTrees?: Readonly<Record<string, string>> | undefined;
  /**
   * Version of the security-scanner pack this build ships (see `scannerPackVersion`),
   * absent when it ships none. The host keeps it in its own folder, apart from `deps/`.
   */
  readonly scannersVersion?: string | undefined;
}

export interface RemoteSshProbeReport {
  readonly nodeVersion: string | null;
  /** `tar` is on the login shell's PATH; installing unpacks with it. */
  readonly tar: boolean;
  readonly installed: boolean;
  /** This build's dependency pack is unpacked for the host's platform and Node ABI. */
  readonly depsInstalled: boolean;
  /** `<platform>-<arch>` of the host's `node`, the scanner pack to upload; null when unknown. */
  readonly platform: string | null;
  /** This build's scanner pack is unpacked on the host. */
  readonly scannersInstalled: boolean;
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

function assertSafeDepsHash(depsHash: string): void {
  if (!/^[0-9a-f]{8,64}$/u.test(depsHash)) {
    throw new Error(`Unsupported dependency hash for a remote install: ${depsHash}`);
  }
}

/**
 * Absolute directory of the scanner executables, read by the server
 * (`<root>/scanners/<platform>-<arch>/`). The desktop sets it for its own server too.
 */
export const SAINT_SCANNER_DIR_ENV = "SAINT_SCANNER_DIR";

function assertSafeScannersVersion(version: string): void {
  if (!/^[0-9a-f]{8,64}$/u.test(version)) {
    throw new Error(`Unsupported scanner pack version for a remote install: ${version}`);
  }
}

function assertSafeScannerPlatform(platform: string): void {
  if (!/^(darwin|linux)-(arm64|x64)$/u.test(platform)) {
    throw new Error(`Unsupported scanner platform for a remote install: ${platform}`);
  }
}

/** Restarts each idle agent runtime sooner than a desktop does, freeing its CLI's memory. */
export const REMOTE_PROVIDER_RUNTIME_IDLE_STOP_MS = 3 * 60_000;
/**
 * The server exits after this long without a window, running turn, busy
 * terminal or enabled automation; the next connect starts it again.
 */
export const REMOTE_SERVER_IDLE_EXIT_MS = 10 * 60_000;
/**
 * V8 limits of the remote server: a ceiling against runaway growth on a host
 * many users share (V8's default is about a quarter of RAM, capped near 4 GB),
 * and a smaller young generation, as Emdash's workspace server uses.
 */
export const REMOTE_SERVER_NODE_FLAGS = ["--max-old-space-size=1024", "--max-semi-space-size=8"];

/**
 * Optional read-only store an administrator fills for every account of a host
 * (`versions/` and `deps/`, same layout as the per-account store). Set in the
 * login shell's environment; clients only read it and never remove from it.
 */
export const REMOTE_SHARED_STORE_ENV = "SAINT_REMOTE_SHARED_STORE";

/**
 * Overrides where accounts share installs when no administrator store is set (default
 * `/Users/Shared/saint-remote` on macOS, `/var/tmp/saint-remote` elsewhere). Absolute path.
 */
export const REMOTE_AUTO_STORE_ENV = "SAINT_REMOTE_AUTO_STORE";

// The scanner pack lives in the shared store next to versions/ and deps/, one folder per
// pack version, so it uploads once per host and every install folder reuses it.
function scannerPreambleLines(target: RemoteSshScriptTarget): string[] {
  if (!target.scannersVersion) return [];
  assertSafeScannersVersion(target.scannersVersion);
  return [
    "scanner_pa=$(node -p 'process.platform + \"-\" + process.arch' 2>/dev/null || echo none)",
    `scanner_root="$store_root/scanners/${target.scannersVersion}"`,
    'scanner_dir="$scanner_root/scanners/$scanner_pa"',
  ];
}

function preamble(target: RemoteSshScriptTarget): string {
  assertSafeVersion(target.version);
  assertSafeDepsHash(target.depsHash);
  return [
    "set -eu",
    `root="$HOME/"${quoteShell(target.remoteRoot)}`,
    `store_root="$HOME/"${quoteShell(target.storeRoot)}`,
    'store="$store_root/versions"',
    'deps_store="$store_root/deps"',
    `version=${quoteShell(target.version)}`,
    'staging="$root/staging/$version"',
    'run_dir="$root/run"',
    `session=${quoteShell(remoteTmuxSessionName(target.remoteRoot))}`,
    `report() { printf '${REMOTE_SSH_REPORT_PREFIX}%s\\n' "$1"; }`,
    // Native modules (node-pty) only load on the platform and Node ABI they were
    // built for, so a Node upgrade on the host gets its own dependency install.
    "node_abi=$(node -p process.versions.modules 2>/dev/null || echo none)",
    `deps_key="${target.depsHash}-$(uname -s | tr 'A-Z' 'a-z')-$(uname -m)-node$node_abi"`,
    'deps_link="../../deps/$deps_key/node_modules"',
    `shared="\${${REMOTE_SHARED_STORE_ENV}:-}"`,
    'case "$shared" in /*) ;; *) shared="" ;; esac',
    ...autoStorePreambleLines(target),
    // A version is ready when it is installed and links to dependencies built
    // for this host's ABI. $1 is a store root holding versions/ and deps/.
    "version_ready() {",
    '  [ -f "$1/versions/$version/.installed" ] || return 1',
    '  [ "$(readlink "$1/versions/$version/node_modules" 2>/dev/null)" = "$deps_link" ] || return 1',
    '  [ -f "$1/deps/$deps_key/.installed" ]',
    "}",
    ...scannerPreambleLines(target),
    'install_dir="$store/$version"',
    'if [ -n "$shared" ] && version_ready "$shared"; then install_dir="$shared/versions/$version"; fi',
    ...autoStoreFunctionLines(),
  ].join("\n");
}

/**
 * Where accounts without an administrator's SAINT_REMOTE_SHARED_STORE share installs: a folder
 * any account may create entries in (sticky, like /tmp), so the first to need a version publishes
 * it and nobody can replace or delete another account's. Off unless the desktop sent the hashes
 * it expects, and on hosts whose platform has no expected dependency hash.
 */
function autoStorePreambleLines(target: RemoteSshScriptTarget): string[] {
  const depsTrees = target.depsTrees ?? {};
  if (!target.bundleTree || Object.keys(depsTrees).length === 0) return ['auto_shared=""'];
  if (!/^[0-9a-f]{64}$/u.test(target.bundleTree)) {
    throw new Error("The bundle tree hash must be 64 hex digits.");
  }
  for (const tree of Object.values(depsTrees)) {
    if (!/^[0-9a-f]{64}$/u.test(tree))
      throw new Error("A dependency tree hash must be 64 hex digits.");
  }
  return [
    `bundle_tree=${quoteShell(target.bundleTree)}`,
    `deps_tree=$(node -p 'JSON.parse(process.argv[1])[process.platform + "-" + process.arch] || ""' ${quoteShell(JSON.stringify(depsTrees))} 2>/dev/null || true)`,
    'auto_shared=""',
    'if [ -z "$shared" ] && [ -n "$deps_tree" ]; then',
    `  auto_shared="\${${REMOTE_AUTO_STORE_ENV}:-}"`,
    '  case "$auto_shared" in /*) ;; *)',
    '    case "$(uname -s)" in Darwin) auto_shared=/Users/Shared/saint-remote ;; *) auto_shared=/var/tmp/saint-remote ;; esac',
    "  ;; esac",
    "fi",
  ];
}

function autoStoreFunctionLines(): string[] {
  return [
    `tree_hash() { node -e ${quoteShell(REMOTE_TREE_HASH_SCRIPT)} "$@"; }`,
    // Ready AND byte-identical to what this desktop ships: another account's install is trusted
    // only after hashing every file, never by its name or marker.
    "auto_ready() {",
    '  version_ready "$1" || return 1',
    '  [ "$(tree_hash "$1/versions/$version" .installed node_modules 2>/dev/null)" = "$bundle_tree" ] || return 1',
    '  [ "$(tree_hash "$1/deps/$deps_key" .installed 2>/dev/null)" = "$deps_tree" ]',
    "}",
    // This account's own install wins when it has one; otherwise a verified shared one is used.
    "pick_install_dir() {",
    '  [ "$install_dir" = "$store/$version" ] || return 0',
    '  version_ready "$store_root" && return 0',
    '  if [ -n "$auto_shared" ] && auto_ready "$auto_shared"; then install_dir="$auto_shared/versions/$version"; fi',
    "  return 0",
    "}",
    // Folders other accounts may add to but not replace from: sticky and world-writable, set only
    // by the account that creates them.
    "auto_prepare() {",
    '  mkdir -p "$1/versions" "$1/deps" 2>/dev/null || return 1',
    '  for auto_dir in "$1" "$1/versions" "$1/deps"; do',
    '    if [ -O "$auto_dir" ]; then chmod 1777 "$auto_dir" 2>/dev/null || true; fi',
    '    [ -w "$auto_dir" ] || return 1',
    "  done",
    "}",
  ];
}

/** One tmux session per install folder, so Stable, Beta and custom folders never collide. */
export function remoteTmuxSessionName(remoteRoot: string): string {
  return remoteRoot.replace(/^\.+/u, "").replace(/[^A-Za-z0-9_-]+/gu, "-") || "saint-remote";
}

// The pid file outlives a server that exited on its own (idle exit, crash), and
// the system may hand its pid to another process; only a Saint server counts.
// Without a usable `ps` the pid alone decides, as before.
const SERVER_ALIVE_FUNCTION = `server_alive() {
  [ -f "$run_dir/server.pid" ] || return 1
  pid=$(cat "$run_dir/server.pid" 2>/dev/null || true)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 1
  command_line=$(ps -p "$pid" -o args= 2>/dev/null) || return 0
  case "$command_line" in *dist/index.mjs*) return 0 ;; esac
  return 1
}`;

/** Reports node/tar availability, whether this version is installed, and any live server. */
export function buildRemoteProbeScript(target: RemoteSshScriptTarget): string {
  return `${preamble(target)}
${SERVER_ALIVE_FUNCTION}
pick_install_dir
node_version=$(node --version 2>/dev/null || true)
tar_ok=false
if command -v tar >/dev/null 2>&1; then tar_ok=true; fi
installed=false
if [ "$install_dir" != "$store/$version" ] || version_ready "$store_root"; then installed=true; fi
deps=false
if [ -f "$deps_store/$deps_key/.installed" ]; then deps=true; fi
host_platform=$(node -p 'process.platform + "-" + process.arch' 2>/dev/null || true)
scanners=false
${target.scannersVersion ? 'if [ -f "$scanner_root/.installed" ] && [ -d "$scanner_dir" ]; then scanners=true; fi' : ""}
server=null
if server_alive && [ -f "$run_dir/server.json" ] && [ -f "$run_dir/token" ]; then
  server="{\\"info\\":$(cat "$run_dir/server.json"),\\"token\\":\\"$(cat "$run_dir/token")\\"}"
fi
report "{\\"kind\\":\\"probe\\",\\"node\\":\\"$node_version\\",\\"tar\\":$tar_ok,\\"installed\\":$installed,\\"deps\\":$deps,\\"platform\\":\\"$host_platform\\",\\"scanners\\":$scanners,\\"server\\":$server}"
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

// rename(2) never replaces a non-empty folder: when another install folder
// published the same folder first, keep theirs. A folder without .installed is
// a broken install and is replaced. With a link target, an existing version
// keeps its files and moves its node_modules link to these dependencies (the
// rename swaps the link atomically, so a running server never sees it missing).
const PUBLISH_FUNCTION = `publish() {
  node -e '
const fs = require("fs");
const [staging, target, link] = process.argv.slice(1);
try {
  fs.renameSync(staging, target);
} catch {
  if (fs.existsSync(target + "/.installed")) {
    if (link) {
      const next = target + "/node_modules.next-" + process.pid;
      fs.rmSync(next, { force: true });
      fs.symlinkSync(link, next);
      fs.renameSync(next, target + "/node_modules");
    }
    fs.rmSync(staging, { recursive: true, force: true });
  } else {
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
  }
}
' "$@"
}`;

/**
 * Unpacks the dependency pack the app uploaded (patched, with node-pty
 * binaries for every supported host) into `deps/`, once per pack, platform and
 * Node ABI, so versions with the same pack reuse it, as Orca's relay reuses its
 * native folder. No host runs npm, patch or a compiler. It keeps only this
 * host's node-pty binary; the version folder then links its `node_modules`
 * there and is published with one atomic rename.
 */
export function buildRemoteInstallScript(target: RemoteSshScriptTarget): string {
  return `${preamble(target)}
${PUBLISH_FUNCTION}
mkdir -p "$root/staging"
# Killing the local ssh (timeout, Cancel) sends the remote shell no signal, so an
# earlier install of this folder can still be running in the staging below.
pid_file="$root/staging/install.pid"
old_pid=$(cat "$pid_file" 2>/dev/null || true)
if [ -n "$old_pid" ] && [ "$old_pid" != "$$" ] && kill -0 "$old_pid" 2>/dev/null; then
  case "$(ps -p "$old_pid" -o args= 2>/dev/null || true)" in
    "sh -s"*)
      echo "Stopping an earlier install that is still running." >&2
      pkill -TERM -P "$old_pid" 2>/dev/null || true
      kill -TERM "$old_pid" 2>/dev/null || true
      sleep 2
      ;;
  esac
fi
echo "$$" >"$pid_file"
# The pack leaves the version's staging at once so it never ships inside the version folder, and
# stays put until an install succeeds so a fallback can use it too.
pack_file="$root/staging/deps-pack-$version.tgz"
if [ -f "$staging/deps.tar.gz" ]; then mv -f "$staging/deps.tar.gz" "$pack_file"; fi
deps_staging="$root/staging/deps-$deps_key"
# Publishes $1 as $2 (and, for a version, links its node_modules as $3). The shared store may
# sit on another filesystem than $HOME, so it gets a copy others can read but not write.
publish_to() {
  if [ "$shared_install" = true ]; then
    shared_tmp="$auto_shared/.tmp-$(id -u)-$$-\${2##*/}"
    rm -rf "$shared_tmp"
    cp -RP "$1" "$shared_tmp" || return 1
    chmod -R go+rX,go-w "$shared_tmp" || return 1
    publish "$shared_tmp" "$2" "$3" || return 1
    rm -rf "$shared_tmp"
  else
    publish "$1" "$2" "$3"
  fi
}
# Installs into the store folder $1 (versions/ and deps/ live in it). Every step checks its own
# status: with the shared store a failure falls back to this account's store.
install_into() {
  t_root="$1"
  mkdir -p "$t_root/versions" "$t_root/deps" || return 1
  if [ ! -f "$t_root/deps/$deps_key/.installed" ]; then
    if [ ! -f "$pack_file" ]; then
      echo "Saint did not upload its dependency pack; connect again to upload it." >&2
      return 1
    fi
    rm -rf "$deps_staging"
    mkdir -p "$deps_staging" || return 1
    echo "Unpacking the dependencies Saint uploaded." >&2
    tar -xzf "$pack_file" -C "$deps_staging" || return 1
    prebuild=$(node -p 'process.platform + "-" + process.arch') || return 1
    if [ ! -d "$deps_staging/node_modules/@lydell/node-pty-$prebuild" ]; then
      echo "Saint ships no terminal (node-pty) binary for $prebuild." >&2
      return 1
    fi
    for platform_dir in "$deps_staging"/node_modules/@lydell/node-pty-*; do
      [ -e "$platform_dir" ] || continue
      [ "\${platform_dir##*/node-pty-}" = "$prebuild" ] || rm -rf "$platform_dir"
    done
    if [ "$shared_install" = true ] && [ "$(tree_hash "$deps_staging" .installed)" != "$deps_tree" ]; then
      echo "The unpacked dependencies differ from what Saint ships." >&2
      return 1
    fi
    : >"$deps_staging/.installed"
    publish_to "$deps_staging" "$t_root/deps/$deps_key" "" || return 1
  fi
  rm -rf "$staging/node_modules"
  ln -s "$deps_link" "$staging/node_modules" || return 1
  if [ "$shared_install" = true ] && [ "$(tree_hash "$staging" .installed node_modules)" != "$bundle_tree" ]; then
    echo "The uploaded Saint files differ from what Saint ships." >&2
    return 1
  fi
  : >"$staging/.installed"
  publish_to "$staging" "$t_root/versions/$version" "$deps_link" || return 1
  # Another account may have published this version first, or squatted its name: only a tree that
  # hashes right counts.
  if [ "$shared_install" = true ]; then auto_ready "$t_root" || return 1; fi
  return 0
}
shared_install=false
if [ -n "$auto_shared" ] && auto_prepare "$auto_shared"; then
  shared_install=true
  if install_into "$auto_shared"; then
    echo "Installed Saint for every account of this host in $auto_shared." >&2
  else
    shared_install=false
    echo "Could not use the shared Saint folder $auto_shared; installing for this account." >&2
    install_into "$store_root"
  fi
else
  install_into "$store_root"
fi
rm -rf "$staging" "$deps_staging" "$pack_file"
rm -f "$pid_file"
rmdir "$root/staging" 2>/dev/null || true
report '{"kind":"installed"}'
`;
}

/**
 * Shell command that unpacks one `scanner-<platform>-<arch>.tar.gz` from stdin into
 * this install folder's staging. Only the host's own pack is ever sent.
 */
export function buildRemoteScannerUploadCommand(
  target: RemoteSshScriptTarget,
  platform: string,
): string {
  assertSafeScannersVersion(target.scannersVersion ?? "");
  assertSafeScannerPlatform(platform);
  const staging = `"$HOME/"${quoteShell(`${target.remoteRoot}/staging/scanners-${target.scannersVersion}`)}`;
  const dir = `${staging}/${quoteShell(`scanners/${platform}`)}`;
  return `sh -c ${quoteShell(`set -eu; rm -rf ${staging}; mkdir -p ${dir}; tar -xzf - -C ${dir}`)}`;
}

/**
 * Publishes the uploaded scanner pack to `scanners/<version>/` in the shared store
 * with one atomic rename (a pack another install folder published first is kept).
 * The server finds it through SAINT_SCANNER_DIR, written by the start script.
 */
export function buildRemoteScannerInstallScript(
  target: RemoteSshScriptTarget,
  platform: string,
): string {
  assertSafeScannersVersion(target.scannersVersion ?? "");
  assertSafeScannerPlatform(platform);
  return `${preamble(target)}
${PUBLISH_FUNCTION}
scanner_staging="$root/staging/scanners-${target.scannersVersion}"
if [ ! -d "$scanner_staging/scanners/${platform}" ] || [ -z "$(ls -A "$scanner_staging/scanners/${platform}")" ]; then
  echo "Saint did not upload its scanner pack." >&2
  exit 1
fi
if [ "$scanner_pa" != ${quoteShell(platform)} ]; then
  echo "The scanner pack is for ${platform}, this host is $scanner_pa." >&2
  exit 1
fi
mkdir -p "$store_root/scanners"
chmod -R go-w "$scanner_staging"
: >"$scanner_staging/.installed"
publish "$scanner_staging" "$scanner_root"
rmdir "$root/staging" 2>/dev/null || true
report '{"kind":"scanners"}'
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
 * waits for /health, and removes installed versions no server runs and the
 * dependency folders no remaining version links. Only the Codex and Claude
 * providers run (`SAINT_PROVIDERS`); idle agent runtimes stop after
 * REMOTE_PROVIDER_RUNTIME_IDLE_STOP_MS and the server exits after
 * REMOTE_SERVER_IDLE_EXIT_MS unused. The token travels on stdin and lives in a
 * 0600 file, never in a process argument list. A version from the shared store
 * runs in place and is never removed.
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
pick_install_dir
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
  echo 'export SAINT_PROVIDER_RUNTIME_IDLE_STOP_MS=${REMOTE_PROVIDER_RUNTIME_IDLE_STOP_MS}'
  echo 'export SAINT_IDLE_EXIT_MS=${REMOTE_SERVER_IDLE_EXIT_MS}'
  echo 'export ${CLIENT_SCOPED_ENV}=1'
${scannerEnvLines(target)}
  echo "echo \\$\\$ >$(quote "$run_dir/server.pid")"
  echo "exec node ${REMOTE_SERVER_NODE_FLAGS.join(" ")} $(quote "$install_dir/dist/index.mjs") --mode web --host 127.0.0.1 --port $port --home-dir $(quote "$root/home") --no-browser${devUrlFlag} >>$(quote "$run_dir/server.log") 2>&1"
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
# Dependency folders go once no remaining version links them. One published in
# the last hour may belong to another folder's install that has not published
# its version yet, so it stays until a later start.
for deps_dir in "$deps_store"/*; do
  [ -d "$deps_dir" ] || continue
  linked=false
  for other in "$store"/*; do
    [ "$(readlink "$other/node_modules" 2>/dev/null)" = "../../deps/\${deps_dir##*/}/node_modules" ] && linked=true
  done
  [ "$linked" = true ] && continue
  [ -n "$(find "$deps_dir" -maxdepth 0 -mmin -60 2>/dev/null)" ] && continue
  rm -rf "$deps_dir"
done
${scannerCleanupLines(target)}
${autoStoreCleanupLines()}
# Folders installed before the shared store kept their own versions.
if [ "$root/versions" != "$store" ]; then rm -rf "$root/versions"; fi
report "{\\"kind\\":\\"started\\",\\"port\\":$port}"
`;
}

// The machine-wide folder keeps every version any account published, and an account can delete
// only what it owns (the folder is sticky). A starting server removes the old versions it owns that
// no process runs and that are a day old, the dependency folders no version links any more, and
// copies a failed install left behind. Without the folder there is nothing to do.
function autoStoreCleanupLines(): string {
  return `if [ -n "$auto_shared" ] && [ -d "$auto_shared/versions" ]; then
  for other in "$auto_shared"/versions/*; do
    [ -d "$other" ] || continue
    [ "$other" = "$install_dir" ] && continue
    [ "$other" = "$auto_shared/versions/$version" ] && continue
    [ -O "$other" ] || continue
    [ -n "$(find "$other" -maxdepth 0 -mmin -1440 2>/dev/null)" ] && continue
    in_use "$other" || rm -rf "$other"
  done
  for deps_dir in "$auto_shared"/deps/*; do
    [ -d "$deps_dir" ] || continue
    [ -O "$deps_dir" ] || continue
    linked=false
    for other in "$auto_shared"/versions/*; do
      [ "$(readlink "$other/node_modules" 2>/dev/null)" = "../../deps/\${deps_dir##*/}/node_modules" ] && linked=true
    done
    [ "$linked" = true ] && continue
    [ -n "$(find "$deps_dir" -maxdepth 0 -mmin -60 2>/dev/null)" ] && continue
    rm -rf "$deps_dir"
  done
  for leftover in "$auto_shared"/.tmp-*; do
    [ -d "$leftover" ] || continue
    [ -O "$leftover" ] || continue
    [ -n "$(find "$leftover" -maxdepth 0 -mmin +1440 2>/dev/null)" ] && rm -rf "$leftover"
  done
fi`;
}

// Without the pack on this host the server starts without the variable and the scanner
// runner reports its scanners as unavailable.
function scannerEnvLines(target: RemoteSshScriptTarget): string {
  if (!target.scannersVersion) return "";
  return `  if [ -f "$scanner_root/.installed" ] && [ -d "$scanner_dir" ]; then
    echo "export ${SAINT_SCANNER_DIR_ENV}=$(quote "$scanner_dir")"
  fi`;
}

// Scanner packs of older builds go a day after they stop being current, long after
// the servers that used them have exited.
function scannerCleanupLines(target: RemoteSshScriptTarget): string {
  if (!target.scannersVersion) return "";
  return `for old in "$store_root"/scanners/*; do
  [ -d "$old" ] || continue
  [ "$old" = "$scanner_root" ] && continue
  [ -n "$(find "$old" -maxdepth 0 -mmin +1440 2>/dev/null)" ] && rm -rf "$old"
done`;
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

/**
 * Moves this desktop's own older folder's data (`<remoteRoot>/home`, where `target.remoteRoot` is
 * that older folder) into the account's shared folder, stopping its server first. The first
 * desktop to connect does it; nothing happens when there is no older data. When the shared folder
 * already holds data (another desktop got there first) or another desktop is moving right now, the
 * older data stays where it is: two databases are never merged. Reports `migrated` or `legacy`
 * (the older folder keeps being used), and nothing when there was nothing to move.
 */
export function buildRemoteMigrateRootScript(target: RemoteSshScriptTarget): string {
  return `${preamble(target)}
${SERVER_ALIVE_FUNCTION}
shared_home="$store_root/home"
if [ ! -d "$root/home" ]; then exit 0; fi
lock="$store_root/.migrating"
mkdir -p "$store_root"
# A lock a crashed move left behind must not block every later desktop.
[ -n "$(find "$lock" -maxdepth 0 -mmin +10 2>/dev/null)" ] && rmdir "$lock" 2>/dev/null || true
if [ -e "$shared_home" ] || ! mkdir "$lock" 2>/dev/null; then
  report '{"kind":"legacy"}'
  exit 0
fi
trap 'rmdir "$lock" 2>/dev/null || true' EXIT
${stopServerLines()}
if mv "$root/home" "$shared_home"; then
  report '{"kind":"migrated"}'
else
  report '{"kind":"legacy"}'
fi
`;
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
    tar: report.tar === true,
    installed: report.installed === true,
    depsInstalled: report.deps === true,
    platform: typeof report.platform === "string" && report.platform ? report.platform : null,
    scannersInstalled: report.scanners === true,
    server,
  };
}

export function parseRemoteStartReport(stdout: string): { readonly port: number } | null {
  const report = findReport(stdout, "started");
  return report && isPort(report.port) ? { port: report.port } : null;
}

export function hasRemoteReport(
  stdout: string,
  kind: "installed" | "stopped" | "scanners" | "legacy" | "migrated",
): boolean {
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
