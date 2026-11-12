// FILE: remote_ssh_scripts.rs
// Purpose: POSIX shell scripts piped to a Remote SSH host to install, start and stop a Saint
//          server there, plus parsers for their `SAINT_REMOTE ` reports.
// Layer: Desktop Remote SSH utility (ported from the Electron `remoteSshScripts.ts`; the
//        security-scanner pack is not ported: Tauri builds ship none).

use serde::Deserialize;

pub const REPORT_PREFIX: &str = "SAINT_REMOTE ";

/// Reads the script from stdin inside the user's login shell so PATH from shell profiles
/// (nvm, mise, Homebrew) reaches `node`. Outer single quotes keep it valid for fish.
pub const LOGIN_SHELL_COMMAND: &str = r#"sh -c 'exec "${SHELL:-/bin/sh}" -lc "exec sh -s"'"#;

pub const NODE_REQUIREMENT: &str = "Node.js 22.16+, 23.11+ or 24+";

const PROVIDER_RUNTIME_IDLE_STOP_MS: u64 = 3 * 60_000;
const SERVER_IDLE_EXIT_MS: u64 = 10 * 60_000;
const SERVER_NODE_FLAGS: &str = "--max-old-space-size=1024 --max-semi-space-size=8";

/// What `stage-remote-install.ts` wrote to `identity.json`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallIdentity {
    pub version: String,
    pub deps_hash: String,
    #[serde(default)]
    pub bundle_tree: Option<String>,
    #[serde(default)]
    pub deps_trees: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub tree_hash_script: Option<String>,
}

pub struct Target<'a> {
    pub remote_root: &'a str,
    pub store_root: &'a str,
    pub identity: &'a InstallIdentity,
}

pub fn quote_shell(value: &str) -> String {
    format!("'{}'", value.replace('\'', r#"'"'"'"#))
}

fn all(value: &str, ok: impl Fn(char) -> bool) -> bool {
    !value.is_empty() && value.chars().all(ok)
}

fn is_hex(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.len()) && all(value, |c| matches!(c, '0'..='9' | 'a'..='f'))
}

/// One tmux session per install folder, so Stable, Beta and custom folders never collide.
pub fn tmux_session_name(remote_root: &str) -> String {
    let mut out = String::new();
    let mut in_bad_run = false;
    for c in remote_root.trim_start_matches('.').chars() {
        let ok = c.is_ascii_alphanumeric() || c == '_' || c == '-';
        if ok {
            out.push(c);
        } else if !in_bad_run {
            out.push('-');
        }
        in_bad_run = !ok;
    }
    if out.is_empty() {
        "saint-remote".to_string()
    } else {
        out
    }
}

fn preamble(t: &Target) -> Result<String, String> {
    let id = t.identity;
    if !all(&id.version, |c| {
        c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-')
    }) {
        return Err(format!(
            "Unsupported Saint version for a remote install: {}",
            id.version
        ));
    }
    if !is_hex(&id.deps_hash, 8, 64) {
        return Err(format!(
            "Unsupported dependency hash for a remote install: {}",
            id.deps_hash
        ));
    }
    let mut lines = vec![
        "set -eu".to_string(),
        format!(r#"root="$HOME/"{}"#, quote_shell(t.remote_root)),
        format!(r#"store_root="$HOME/"{}"#, quote_shell(t.store_root)),
        r#"store="$store_root/versions""#.into(),
        r#"deps_store="$store_root/deps""#.into(),
        format!("version={}", quote_shell(&id.version)),
        r#"staging="$root/staging/$version""#.into(),
        r#"run_dir="$root/run""#.into(),
        format!("session={}", quote_shell(&tmux_session_name(t.remote_root))),
        format!(r#"report() {{ printf '{REPORT_PREFIX}%s\n' "$1"; }}"#),
        "node_abi=$(node -p process.versions.modules 2>/dev/null || echo none)".into(),
        format!(
            r#"deps_key="{}-$(uname -s | tr 'A-Z' 'a-z')-$(uname -m)-node$node_abi""#,
            id.deps_hash
        ),
        r#"deps_link="../../deps/$deps_key/node_modules""#.into(),
        r#"shared="${SAINT_REMOTE_SHARED_STORE:-}""#.into(),
        r#"case "$shared" in /*) ;; *) shared="" ;; esac"#.into(),
    ];
    lines.extend(auto_store_preamble_lines(id)?);
    lines.push(
        r#"version_ready() {
  [ -f "$1/versions/$version/.installed" ] || return 1
  [ "$(readlink "$1/versions/$version/node_modules" 2>/dev/null)" = "$deps_link" ] || return 1
  [ -f "$1/deps/$deps_key/.installed" ]
}
install_dir="$store/$version"
if [ -n "$shared" ] && version_ready "$shared"; then install_dir="$shared/versions/$version"; fi"#
            .into(),
    );
    let tree_hash = id.tree_hash_script.as_deref().unwrap_or("process.exit(1)");
    lines.push(format!(
        r#"tree_hash() {{ node -e {} "$@"; }}
auto_ready() {{
  version_ready "$1" || return 1
  [ "$(tree_hash "$1/versions/$version" .installed node_modules 2>/dev/null)" = "$bundle_tree" ] || return 1
  [ "$(tree_hash "$1/deps/$deps_key" .installed 2>/dev/null)" = "$deps_tree" ]
}}
pick_install_dir() {{
  [ "$install_dir" = "$store/$version" ] || return 0
  version_ready "$store_root" && return 0
  if [ -n "$auto_shared" ] && auto_ready "$auto_shared"; then install_dir="$auto_shared/versions/$version"; fi
  return 0
}}
auto_prepare() {{
  mkdir -p "$1/versions" "$1/deps" 2>/dev/null || return 1
  for auto_dir in "$1" "$1/versions" "$1/deps"; do
    if [ -O "$auto_dir" ]; then chmod 1777 "$auto_dir" 2>/dev/null || true; fi
    [ -w "$auto_dir" ] || return 1
  done
}}"#,
        quote_shell(tree_hash)
    ));
    Ok(lines.join("\n"))
}

/// Accounts share installs in a sticky world-writable folder unless an administrator set
/// SAINT_REMOTE_SHARED_STORE. Off unless the build shipped the hashes to verify them with.
fn auto_store_preamble_lines(id: &InstallIdentity) -> Result<Vec<String>, String> {
    let (Some(bundle_tree), Some(_)) = (id.bundle_tree.as_deref(), id.tree_hash_script.as_deref())
    else {
        return Ok(vec![
            r#"auto_shared="""#.into(),
            r#"bundle_tree="""#.into(),
            r#"deps_tree="""#.into(),
        ]);
    };
    if id.deps_trees.is_empty() {
        return Ok(vec![
            r#"auto_shared="""#.into(),
            r#"bundle_tree="""#.into(),
            r#"deps_tree="""#.into(),
        ]);
    }
    if !is_hex(bundle_tree, 64, 64) || !id.deps_trees.values().all(|t| is_hex(t, 64, 64)) {
        return Err("A remote install tree hash must be 64 hex digits.".into());
    }
    let trees = serde_json::to_string(&id.deps_trees).map_err(|e| e.to_string())?;
    Ok(vec![
        format!("bundle_tree={}", quote_shell(bundle_tree)),
        format!(
            r#"deps_tree=$(node -p 'JSON.parse(process.argv[1])[process.platform + "-" + process.arch] || ""' {} 2>/dev/null || true)"#,
            quote_shell(&trees)
        ),
        r#"auto_shared=""
if [ -z "$shared" ] && [ -n "$deps_tree" ]; then
  auto_shared="${SAINT_REMOTE_AUTO_STORE:-}"
  case "$auto_shared" in /*) ;; *)
    case "$(uname -s)" in Darwin) auto_shared=/Users/Shared/saint-remote ;; *) auto_shared=/var/tmp/saint-remote ;; esac
  ;; esac
fi"#
            .into(),
    ])
}

const SERVER_ALIVE_FUNCTION: &str = r#"server_alive() {
  [ -f "$run_dir/server.pid" ] || return 1
  pid=$(cat "$run_dir/server.pid" 2>/dev/null || true)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 1
  command_line=$(ps -p "$pid" -o args= 2>/dev/null) || return 0
  case "$command_line" in *dist/index.mjs*) return 0 ;; esac
  return 1
}"#;

const STOP_SERVER_LINES: &str = r#"if server_alive; then
  kill "$pid" 2>/dev/null || true
  waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 50 ]; do sleep 0.2; waited=$((waited + 1)); done
  kill -9 "$pid" 2>/dev/null || true
fi
if command -v tmux >/dev/null 2>&1; then tmux kill-session -t "$session" 2>/dev/null || true; fi
rm -f "$run_dir/server.pid" "$run_dir/server.json""#;

/// Reports node/tar availability, whether this version is installed, and any live server.
pub fn probe_script(t: &Target) -> Result<String, String> {
    Ok(format!(
        r#"{}
{SERVER_ALIVE_FUNCTION}
pick_install_dir
node_version=$(node --version 2>/dev/null || true)
tar_ok=false
if command -v tar >/dev/null 2>&1; then tar_ok=true; fi
installed=false
if [ "$install_dir" != "$store/$version" ] || version_ready "$store_root"; then installed=true; fi
deps=false
if [ -f "$deps_store/$deps_key/.installed" ]; then deps=true; fi
server=null
if server_alive && [ -f "$run_dir/server.json" ] && [ -f "$run_dir/token" ]; then
  server="{{\"info\":$(cat "$run_dir/server.json"),\"token\":\"$(cat "$run_dir/token")\"}}"
fi
report "{{\"kind\":\"probe\",\"node\":\"$node_version\",\"tar\":$tar_ok,\"installed\":$installed,\"deps\":$deps,\"server\":$server}}"
"#,
        preamble(t)?
    ))
}

/// Unpacks the gzipped bundle from stdin into this install folder's own staging folder.
pub fn upload_command(t: &Target) -> String {
    let staging = format!(
        r#""$HOME/"{}"#,
        quote_shell(&format!("{}/staging/{}", t.remote_root, t.identity.version))
    );
    format!(
        "sh -c {}",
        quote_shell(&format!(
            "set -eu; rm -rf {staging}; mkdir -p {staging}; tar -xzf - -C {staging}"
        ))
    )
}

/// Writes the dependency pack from stdin into the staging folder `upload_command` made.
pub fn deps_upload_command(t: &Target) -> String {
    let file = format!(
        r#""$HOME/"{}"#,
        quote_shell(&format!(
            "{}/staging/{}/deps.tar.gz",
            t.remote_root, t.identity.version
        ))
    );
    format!("sh -c {}", quote_shell(&format!("set -eu; cat >{file}")))
}

const PUBLISH_FUNCTION: &str = r#"publish() {
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
}"#;

/// Unpacks the uploaded dependency pack into `deps/` (once per pack, platform and Node ABI),
/// links the version's `node_modules` there and publishes the version with one rename.
pub fn install_script(t: &Target) -> Result<String, String> {
    Ok(format!(
        r#"{}
{PUBLISH_FUNCTION}
{}"#,
        preamble(t)?,
        r#"mkdir -p "$root/staging"
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
pack_file="$root/staging/deps-pack-$version.tgz"
if [ -f "$staging/deps.tar.gz" ]; then mv -f "$staging/deps.tar.gz" "$pack_file"; fi
deps_staging="$root/staging/deps-$deps_key"
publish_to() {
  if [ "$shared_install" = true ]; then
    shared_tmp="$auto_shared/.tmp-$(id -u)-$$-${2##*/}"
    rm -rf "$shared_tmp"
    cp -RP "$1" "$shared_tmp" || return 1
    chmod -R go+rX,go-w "$shared_tmp" || return 1
    publish "$shared_tmp" "$2" "$3" || return 1
    rm -rf "$shared_tmp"
  else
    publish "$1" "$2" "$3"
  fi
}
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
      [ "${platform_dir##*/node-pty-}" = "$prebuild" ] || rm -rf "$platform_dir"
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
"#
    ))
}

/// Stops any server from this install folder, starts this version on a free loopback port in
/// tmux (nohup without tmux), waits for /health and removes versions no server runs. The token
/// lives in a 0600 file, never in a process argument list.
pub fn start_script(t: &Target, token: &str, dev_url: Option<&str>) -> Result<String, String> {
    if !all(token, |c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err("Remote auth token must be URL-safe.".into());
    }
    let dev_url_flag = match dev_url {
        Some(url)
            if (url.starts_with("http://") || url.starts_with("https://"))
                && all(url, |c| {
                    c.is_ascii_alphanumeric() || matches!(c, '.' | ':' | '[' | ']' | '/' | '-')
                }) =>
        {
            format!(" --dev-url {url}")
        }
        _ => String::new(),
    };
    Ok(format!(
        r#"{preamble}
{SERVER_ALIVE_FUNCTION}
pick_install_dir
{STOP_SERVER_LINES}
mkdir -p "$run_dir" "$root/home"
chmod 700 "$root" "$run_dir"
port=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{{process.stdout.write(String(s.address().port));s.close()}})')
umask 077
printf '%s' {token} >"$run_dir/token"
quote() {{ printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }}
{{
  echo '#!/bin/sh'
  echo "export PATH=$(quote "$PATH")"
  echo "SAINT_AUTH_TOKEN=\$(cat $(quote "$run_dir/token"))"
  echo 'export SAINT_AUTH_TOKEN'
  echo 'export SAINT_PROVIDERS=codex,claudeAgent'
  echo 'export SAINT_PROVIDER_RUNTIME_IDLE_STOP_MS={PROVIDER_RUNTIME_IDLE_STOP_MS}'
  echo 'export SAINT_IDLE_EXIT_MS={SERVER_IDLE_EXIT_MS}'
  echo 'export SAINT_CLIENT_SCOPED=1'
  echo "echo \$\$ >$(quote "$run_dir/server.pid")"
  echo "exec node {SERVER_NODE_FLAGS} $(quote "$install_dir/dist/index.mjs") --mode web --host 127.0.0.1 --port $port --home-dir $(quote "$root/home") --no-browser{dev_url_flag} >>$(quote "$run_dir/server.log") 2>&1"
}} >"$run_dir/server.sh"
printf '{{"port":%s,"version":"%s"}}' "$port" "$version" >"$run_dir/server.json"
if command -v tmux >/dev/null 2>&1; then
  tmux new-session -d -s "$session" "sh $(quote "$run_dir/server.sh")"
else
  nohup sh "$run_dir/server.sh" </dev/null >/dev/null 2>&1 &
fi
if ! node -e '
const url = "http://127.0.0.1:" + process.argv[1] + "/health";
const deadline = Date.now() + 90000;
const poll = () => fetch(url).then((r) => {{ if (r.ok) process.exit(0); throw 0; }})
  .catch(() => Date.now() > deadline ? process.exit(1) : setTimeout(poll, 500));
poll();
' "$port"; then
  echo "The Saint server did not become ready on the remote host:" >&2
  tail -n 40 "$run_dir/server.log" >&2 2>/dev/null || true
  exit 1
fi
in_use() {{
  command -v pgrep >/dev/null 2>&1 || return 0
  pgrep -f -- "$1/dist/index.mjs" >/dev/null 2>&1
}}
for other in "$store"/*; do
  [ -e "$other" ] || continue
  [ "$other" = "$install_dir" ] && continue
  in_use "$other" || rm -rf "$other"
done
for deps_dir in "$deps_store"/*; do
  [ -d "$deps_dir" ] || continue
  linked=false
  for other in "$store"/*; do
    [ "$(readlink "$other/node_modules" 2>/dev/null)" = "../../deps/${{deps_dir##*/}}/node_modules" ] && linked=true
  done
  [ "$linked" = true ] && continue
  [ -n "$(find "$deps_dir" -maxdepth 0 -mmin -60 2>/dev/null)" ] && continue
  rm -rf "$deps_dir"
done
if [ -n "$auto_shared" ] && [ -d "$auto_shared/versions" ]; then
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
      [ "$(readlink "$other/node_modules" 2>/dev/null)" = "../../deps/${{deps_dir##*/}}/node_modules" ] && linked=true
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
fi
if [ "$root/versions" != "$store" ]; then rm -rf "$root/versions"; fi
report "{{\"kind\":\"started\",\"port\":$port}}"
"#,
        preamble = preamble(t)?,
        token = quote_shell(token),
    ))
}

/// Stops the server from this install folder; installed files and data stay.
pub fn stop_script(t: &Target) -> Result<String, String> {
    Ok(format!(
        "{}\n{SERVER_ALIVE_FUNCTION}\n{STOP_SERVER_LINES}\nreport '{{\"kind\":\"stopped\"}}'\n",
        preamble(t)?
    ))
}

fn find_report(stdout: &str, kind: &str) -> Option<serde_json::Value> {
    stdout
        .lines()
        .filter_map(|line| line.trim_end_matches('\r').strip_prefix(REPORT_PREFIX))
        .filter_map(|json| serde_json::from_str::<serde_json::Value>(json).ok())
        .find(|v| v.get("kind").and_then(|k| k.as_str()) == Some(kind))
}

fn as_port(value: Option<&serde_json::Value>) -> Option<u16> {
    value?
        .as_u64()
        .filter(|p| (1..65536).contains(p))
        .map(|p| p as u16)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeServer {
    pub port: u16,
    pub version: String,
    pub token: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeReport {
    pub node_version: Option<String>,
    pub tar: bool,
    pub installed: bool,
    pub deps_installed: bool,
    pub server: Option<ProbeServer>,
}

pub fn parse_probe(stdout: &str) -> Option<ProbeReport> {
    let r = find_report(stdout, "probe")?;
    let server = (|| {
        let s = r.get("server")?;
        let info = s.get("info")?;
        Some(ProbeServer {
            port: as_port(info.get("port"))?,
            version: info.get("version")?.as_str()?.to_string(),
            token: s
                .get("token")?
                .as_str()
                .filter(|t| !t.is_empty())?
                .to_string(),
        })
    })();
    Some(ProbeReport {
        node_version: r
            .get("node")
            .and_then(|n| n.as_str())
            .filter(|n| !n.is_empty())
            .map(str::to_string),
        tar: r.get("tar").and_then(|v| v.as_bool()) == Some(true),
        installed: r.get("installed").and_then(|v| v.as_bool()) == Some(true),
        deps_installed: r.get("deps").and_then(|v| v.as_bool()) == Some(true),
        server,
    })
}

pub fn parse_started_port(stdout: &str) -> Option<u16> {
    as_port(find_report(stdout, "started")?.get("port"))
}

pub fn has_report(stdout: &str, kind: &str) -> bool {
    find_report(stdout, kind).is_some()
}

/// The server needs `node:sqlite` `StatementSync.columns()`: 22.16, 23.11 or 24+.
pub fn is_node_supported(version: Option<&str>) -> bool {
    let Some(v) = version else { return false };
    let mut parts = v.trim_start_matches('v').split('.');
    let (Some(Ok(major)), Some(Ok(minor))) = (
        parts.next().map(str::parse::<u32>),
        parts.next().map(str::parse::<u32>),
    ) else {
        return false;
    };
    (major == 22 && minor >= 16) || (major == 23 && minor >= 11) || major >= 24
}

fn split_install_version(v: &str) -> (Vec<Option<u64>>, Option<Vec<String>>) {
    // Drop the `-<12 hex>` bundle hash; only the app version orders installs.
    let core = match v.rsplit_once('-') {
        Some((head, tail)) if is_hex(tail, 12, 12) => head,
        _ => v,
    };
    let (nums, pre) = match core.split_once('-') {
        Some((n, p)) => (n, Some(p.split('.').map(str::to_string).collect())),
        None => (core, None),
    };
    (nums.split('.').map(|n| n.parse().ok()).collect(), pre)
}

/// Orders two install folder names (`<app version>-<12 hex>`); negative when `a` is older.
pub fn compare_install_versions(a: &str, b: &str) -> i64 {
    let (ln, lp) = split_install_version(a);
    let (rn, rp) = split_install_version(b);
    for i in 0..3 {
        let (Some(x), Some(y)) = (
            ln.get(i).copied().unwrap_or(Some(0)),
            rn.get(i).copied().unwrap_or(Some(0)),
        ) else {
            return 0;
        };
        if x != y {
            return x as i64 - y as i64;
        }
    }
    match (lp, rp) {
        (None, None) => 0,
        (Some(_), None) => -1,
        (None, Some(_)) => 1,
        (Some(l), Some(r)) => {
            for i in 0..l.len().max(r.len()) {
                let (Some(x), Some(y)) = (l.get(i), r.get(i)) else {
                    return if l.len() < r.len() { -1 } else { 1 };
                };
                let diff = match (x.parse::<i64>(), y.parse::<i64>()) {
                    (Ok(a), Ok(b)) => a - b,
                    _ => x.cmp(y) as i64,
                };
                if diff != 0 {
                    return diff;
                }
            }
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> InstallIdentity {
        InstallIdentity {
            version: "1.2.3-0123456789ab".into(),
            deps_hash: "7947d66a8643".into(),
            bundle_tree: None,
            deps_trees: Default::default(),
            tree_hash_script: None,
        }
    }

    #[test]
    fn scripts_parse_with_sh() {
        let id = identity();
        let t = Target {
            remote_root: ".saint-remote",
            store_root: ".saint-remote",
            identity: &id,
        };
        for script in [
            probe_script(&t).unwrap(),
            install_script(&t).unwrap(),
            start_script(&t, "abc123", Some("http://localhost:5733")).unwrap(),
            stop_script(&t).unwrap(),
        ] {
            let mut child = std::process::Command::new("sh")
                .arg("-n")
                .stdin(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            std::io::Write::write_all(child.stdin.as_mut().unwrap(), script.as_bytes()).unwrap();
            assert!(child.wait().unwrap().success(), "sh -n rejected:\n{script}");
        }
        assert!(start_script(&t, "bad token", None).is_err());
    }

    #[test]
    fn parses_reports_and_versions() {
        let out = "banner\nSAINT_REMOTE {\"kind\":\"probe\",\"node\":\"v22.16.0\",\"tar\":true,\"installed\":false,\"deps\":true,\"server\":{\"info\":{\"port\":4001,\"version\":\"1.2.3-0123456789ab\"},\"token\":\"tok\"}}\n";
        let p = parse_probe(out).unwrap();
        assert!(p.tar && !p.installed && p.deps_installed);
        assert_eq!(p.server.unwrap().port, 4001);
        assert_eq!(
            parse_started_port("SAINT_REMOTE {\"kind\":\"started\",\"port\":5123}"),
            Some(5123)
        );
        assert!(is_node_supported(Some("v22.16.0")));
        assert!(!is_node_supported(Some("v22.15.9")));
        assert!(is_node_supported(Some("v24.0.0")));
        assert!(!is_node_supported(None));
        assert!(compare_install_versions("1.2.4-0123456789ab", "1.2.3-ba9876543210") > 0);
        assert_eq!(
            compare_install_versions("1.2.3-0123456789ab", "1.2.3-ba9876543210"),
            0
        );
        assert!(compare_install_versions("1.2.3-beta.1", "1.2.3") < 0);
        assert_eq!(tmux_session_name(".saint-remote"), "saint-remote");
    }

    /// Runs probe → upload → install → start → stop against this machine with a scratch `$HOME`
    /// (no ssh). Needs `bun run build:remote-install` and Node 22.16+:
    /// `cargo test local_install_round_trip -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn local_install_round_trip() {
        use std::process::{Command, Stdio};
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/remote-install");
        let id: InstallIdentity =
            serde_json::from_str(&std::fs::read_to_string(dir.join("identity.json")).unwrap())
                .unwrap();
        let home = std::env::temp_dir().join(format!("saint-remote-test-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        let t = Target {
            remote_root: ".saint-test-remote",
            store_root: ".saint-test-remote",
            identity: &id,
        };
        let run = |cmd: &str, input: Vec<u8>| {
            let mut child = Command::new("sh")
                .args(["-c", cmd])
                .env("HOME", &home)
                .env("SAINT_REMOTE_AUTO_STORE", home.join("auto"))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap();
            let mut stdin = child.stdin.take().unwrap();
            std::thread::spawn(move || std::io::Write::write_all(&mut stdin, &input));
            let out = child.wait_with_output().unwrap();
            String::from_utf8_lossy(&out.stdout).into_owned()
        };
        let probe = parse_probe(&run("sh -s", probe_script(&t).unwrap().into_bytes())).unwrap();
        assert!(!probe.installed && probe.server.is_none(), "{probe:?}");
        run(
            &upload_command(&t),
            std::fs::read(dir.join("bundle.tar.gz")).unwrap(),
        );
        run(
            &deps_upload_command(&t),
            std::fs::read(dir.join("deps.tar.gz")).unwrap(),
        );
        assert!(has_report(
            &run("sh -s", install_script(&t).unwrap().into_bytes()),
            "installed"
        ));
        let port = parse_started_port(&run(
            "sh -s",
            start_script(&t, "tok123", None).unwrap().into_bytes(),
        ));
        println!("started on {port:?}");
        let probe = parse_probe(&run("sh -s", probe_script(&t).unwrap().into_bytes())).unwrap();
        assert!(probe.installed, "{probe:?}");
        assert_eq!(probe.server.as_ref().map(|s| s.port), port);
        assert!(has_report(
            &run("sh -s", stop_script(&t).unwrap().into_bytes()),
            "stopped"
        ));
        let _ = std::fs::remove_dir_all(&home);
    }
}
