// FILE: managedTerminalWrappers.ts
// Purpose: Create Superset-style managed command wrappers so terminal agent identity is canonical
// and survives zsh startup that rewrites PATH.

import fs from "node:fs";
import path from "node:path";

import {
  defaultTerminalTitleForCliKind,
  managedTerminalCommandNameForCliKind,
  SAINT_TERMINAL_HOOK_OSC_PREFIX,
  SAINT_TERMINAL_CLI_KIND_ENV_KEY,
  type TerminalAgentHookEventType,
  type ManagedTerminalCliKind,
} from "@saint/shared/terminalThreads";

import { envPathKeyFor, resolveExecutable } from "../executableLookup.ts";
import {
  ensurePrivateDirectorySync,
  PRIVATE_EXECUTABLE_FILE_MODE,
  PRIVATE_FILE_MODE,
} from "../privatePathPermissions";

export interface ManagedTerminalWrapperState {
  binDir: string | null;
  codexHomeDir: string | null;
  hookScriptPath: string | null;
  claudeSettingsPath: string | null;
  zshDir: string | null;
  targetPathByCliKind: Partial<Record<ManagedTerminalCliKind, string>>;
}

export interface ManagedTerminalProfile {
  readonly instanceId?: string;
  readonly commandName: string;
  readonly targetPath: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly isolateEnvironment: boolean;
  readonly omittedSensitiveEnvironmentNames?: ReadonlyArray<string>;
}

const PROVIDER_PROFILE_MANIFEST_FILENAME = "provider-profiles.json";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function buildHookOscSequence(eventType: TerminalAgentHookEventType): string {
  return `\\033]${SAINT_TERMINAL_HOOK_OSC_PREFIX}${eventType}\\007`;
}

function buildNotifyHookScript(): string {
  return `#!/bin/sh
set -eu
if [ "$#" -gt 0 ]; then
  _saint_hook_input="$1"
else
  _saint_hook_input="$(cat)"
fi

_saint_extract_event() {
  printf '%s' "$_saint_hook_input" | sed -n "s/.*\\\"$1\\\"[[:space:]]*:[[:space:]]*\\\"\\([^\\\"]*\\)\\\".*/\\1/p" | head -n 1
}

_saint_event="$(_saint_extract_event hook_event_name)"
if [ -z "$_saint_event" ]; then
  _saint_type="$(_saint_extract_event type)"
  case "$_saint_type" in
    task_started|userPromptSubmitted|user_prompt_submit)
      _saint_event="Start"
      ;;
    task_complete|agent-turn-complete|stop|session_end|sessionEnd)
      _saint_event="Stop"
      ;;
    exec_approval_request|apply_patch_approval_request|request_user_input)
      _saint_event="PermissionRequest"
      ;;
  esac
fi

_saint_emit_osc() {
  _saint_sequence="$1"
  if [ -w /dev/tty ]; then
    printf '%b' "$_saint_sequence" > /dev/tty 2>/dev/null || printf '%b' "$_saint_sequence"
    return
  fi
  printf '%b' "$_saint_sequence"
}

case "$_saint_event" in
  UserPromptSubmit|PostToolUse|PostToolUseFailure|Start)
    _saint_emit_osc '${buildHookOscSequence("Start")}'
    ;;
  Stop)
    _saint_emit_osc '${buildHookOscSequence("Stop")}'
    ;;
  PermissionRequest|PreToolUse|Notification)
    _saint_emit_osc '${buildHookOscSequence("PermissionRequest")}'
    ;;
esac
`;
}

function buildClaudeSettingsJson(notifyHookPath: string): string {
  const command = notifyHookPath;
  return JSON.stringify(
    {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command }] }],
        Stop: [{ hooks: [{ type: "command", command }] }],
        PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command }] }],
        PostToolUseFailure: [{ matcher: "*", hooks: [{ type: "command", command }] }],
        PermissionRequest: [{ matcher: "*", hooks: [{ type: "command", command }] }],
        Notification: [{ matcher: "*", hooks: [{ type: "command", command }] }],
      },
    },
    null,
    2,
  );
}

function buildCodexHooksJson(notifyHookPath: string): string {
  const command = notifyHookPath;
  return JSON.stringify(
    {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command }] }],
        Stop: [{ hooks: [{ type: "command", command }] }],
      },
    },
    null,
    2,
  );
}

function buildCodexWrapperScript(input: {
  codexHomeDir: string;
  notifyHookPath: string;
  targetPath: string;
}): string {
  const { codexHomeDir, notifyHookPath, targetPath } = input;
  return [
    `export CODEX_HOME=${shellQuote(codexHomeDir)}`,
    `if [ -f ${shellQuote(notifyHookPath)} ]; then`,
    "  export CODEX_TUI_RECORD_SESSION=1",
    '  if [ -z "${CODEX_TUI_SESSION_LOG_PATH:-}" ]; then',
    '    _saint_codex_ts="$(date +%s 2>/dev/null || echo "$$")"',
    '    export CODEX_TUI_SESSION_LOG_PATH="${TMPDIR:-/tmp}/saint-codex-session-$$_${_saint_codex_ts}.jsonl"',
    "  fi",
    "  (",
    '    _saint_log="$CODEX_TUI_SESSION_LOG_PATH"',
    `    _saint_notify=${shellQuote(notifyHookPath)}`,
    '    _saint_last_turn_id=""',
    '    _saint_last_approval_id=""',
    '    _saint_last_exec_call_id=""',
    "    _saint_approval_fallback_seq=0",
    "",
    "    _saint_emit_event() {",
    '      _saint_event="$1"',
    `      _saint_payload=$(printf '{"hook_event_name":"%s"}' "$_saint_event")`,
    '      "$_saint_notify" "$_saint_payload" >/dev/null 2>&1 || true',
    "    }",
    "",
    "    _saint_i=0",
    '    while [ ! -f "$_saint_log" ] && [ "$_saint_i" -lt 200 ]; do',
    "      _saint_i=$((_saint_i + 1))",
    "      sleep 0.05",
    "    done",
    '    if [ ! -f "$_saint_log" ]; then',
    "      exit 0",
    "    fi",
    "",
    '    tail -n 0 -F "$_saint_log" 2>/dev/null | while IFS= read -r _saint_line; do',
    '      case "$_saint_line" in',
    `        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"task_started"'*)`,
    `          _saint_turn_id=$(printf '%s\n' "$_saint_line" | awk -F'"turn_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    '          [ -n "$_saint_turn_id" ] || _saint_turn_id="task_started"',
    '          if [ "$_saint_turn_id" != "$_saint_last_turn_id" ]; then',
    '            _saint_last_turn_id="$_saint_turn_id"',
    '            _saint_emit_event "Start"',
    "          fi",
    "          ;;",
    `        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"'*'_approval_request"'*)`,
    `          _saint_approval_id=$(printf '%s\n' "$_saint_line" | awk -F'"id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    `          [ -n "$_saint_approval_id" ] || _saint_approval_id=$(printf '%s\n' "$_saint_line" | awk -F'"approval_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    `          [ -n "$_saint_approval_id" ] || _saint_approval_id=$(printf '%s\n' "$_saint_line" | awk -F'"call_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    '          if [ -z "$_saint_approval_id" ]; then',
    "            _saint_approval_fallback_seq=$((_saint_approval_fallback_seq + 1))",
    '            _saint_approval_id="approval_request_${_saint_approval_fallback_seq}"',
    "          fi",
    '          if [ "$_saint_approval_id" != "$_saint_last_approval_id" ]; then',
    '            _saint_last_approval_id="$_saint_approval_id"',
    '            _saint_emit_event "PermissionRequest"',
    "          fi",
    "          ;;",
    `        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"exec_command_begin"'*)`,
    `          _saint_exec_call_id=$(printf '%s\n' "$_saint_line" | awk -F'"call_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    '          if [ -n "$_saint_exec_call_id" ]; then',
    '            if [ "$_saint_exec_call_id" != "$_saint_last_exec_call_id" ]; then',
    '              _saint_last_exec_call_id="$_saint_exec_call_id"',
    '              _saint_emit_event "Start"',
    "            fi",
    "          else",
    '            _saint_emit_event "Start"',
    "          fi",
    "          ;;",
    "      esac",
    "    done",
    "  ) &",
    "  SAINT_CODEX_START_WATCHER_PID=$!",
    "fi",
    `${shellQuote(targetPath)} --enable codex_hooks -c ${shellQuote(`notify=["bash",${JSON.stringify(notifyHookPath)}]`)} "$@"`,
    "_saint_status=$?",
    'if [ -n "${SAINT_CODEX_START_WATCHER_PID:-}" ]; then',
    '  kill "$SAINT_CODEX_START_WATCHER_PID" >/dev/null 2>&1 || true',
    '  wait "$SAINT_CODEX_START_WATCHER_PID" 2>/dev/null || true',
    "fi",
    'exit "$_saint_status"',
  ].join("\n");
}

function buildWrapperScript(input: {
  claudeSettingsPath: string;
  cliKind: ManagedTerminalCliKind;
  codexHomeDir: string;
  notifyHookPath: string;
  targetPath: string;
}): string {
  const { claudeSettingsPath, cliKind, codexHomeDir, notifyHookPath, targetPath } = input;
  const commandName = managedTerminalCommandNameForCliKind(cliKind);
  const title = defaultTerminalTitleForCliKind(cliKind);
  const commandBody =
    cliKind === "claude"
      ? `exec ${shellQuote(targetPath)} --settings ${shellQuote(claudeSettingsPath)} "$@"`
      : buildCodexWrapperScript({ codexHomeDir, notifyHookPath, targetPath });
  return [
    "#!/bin/sh",
    `# Managed ${commandName} wrapper injected by saint terminal sessions.`,
    `printf '\\033]0;%s\\007' ${shellQuote(title)}`,
    `export ${SAINT_TERMINAL_CLI_KIND_ENV_KEY}=${shellQuote(cliKind)}`,
    commandBody,
    "",
  ].join("\n");
}

const PROFILE_INHERITED_ENV_KEYS = [
  "ALL_PROXY",
  "CURL_CA_BUNDLE",
  "COLORTERM",
  "COMSPEC",
  "SYSTEMROOT",
  "WINDIR",
  "PATHEXT",
  "TEMP",
  "TMP",
  "FORCE_COLOR",
  "GIT_SSL_CAINFO",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "NO_COLOR",
  "NO_PROXY",
  "no_proxy",
  "PATH",
  "REQUESTS_CA_BUNDLE",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SSH_AUTH_SOCK",
  "TERM",
  "TMPDIR",
  "TZ",
  "USER",
  "XDG_RUNTIME_DIR",
] as const;

export function buildProviderProfileProcessEnv(
  profile: ManagedTerminalProfile,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const inherited = profile.isolateEnvironment
    ? Object.fromEntries(
        Object.entries(baseEnv).filter(([key]) =>
          PROFILE_INHERITED_ENV_KEYS.some((allowed) => allowed.toUpperCase() === key.toUpperCase()),
        ),
      )
    : baseEnv;
  return { ...inherited, ...profile.environment };
}

export function buildProviderProfileWrapperScript(profile: ManagedTerminalProfile): string {
  const fixedEnvironment = Object.entries(profile.environment).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  const environmentArguments = profile.isolateEnvironment
    ? [
        "exec env -i \\",
        ...PROFILE_INHERITED_ENV_KEYS.map((name) =>
          [`  ${name}=\"\${${name}:-}\" `, "\\"].join(""),
        ),
        ...fixedEnvironment.map(([name, value]) =>
          [`  ${name}=${shellQuote(value)} `, "\\"].join(""),
        ),
        `  ${shellQuote(profile.targetPath)} \"$@\"`,
      ]
    : [
        ...fixedEnvironment.map(([name, value]) => `export ${name}=${shellQuote(value)}`),
        `exec ${shellQuote(profile.targetPath)} \"$@\"`,
      ];
  return [
    "#!/bin/sh",
    `# Saint provider profile: ${profile.commandName}`,
    ...(profile.omittedSensitiveEnvironmentNames?.length
      ? [
          `# Sensitive environment is intentionally not serialized: ${profile.omittedSensitiveEnvironmentNames.join(
            ", ",
          )}`,
        ]
      : []),
    ...environmentArguments,
    "",
  ].join("\n");
}

function writeFileIfChanged(filePath: string, content: string, mode: number): void {
  const currentContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  if (currentContent !== content) {
    fs.writeFileSync(filePath, content, { mode });
  }
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // Best effort.
  }
}

function readProviderProfileManifest(rootDir: string): string[] {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(rootDir, PROVIDER_PROFILE_MANIFEST_FILENAME), "utf8"),
    );
    return Array.isArray(parsed)
      ? parsed.filter(
          (value): value is string =>
            typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value),
        )
      : [];
  } catch {
    return [];
  }
}

function synchronizeProviderProfileWrappers(
  rootDir: string,
  profiles: ReadonlyArray<ManagedTerminalProfile>,
): void {
  const nextNames = new Set(profiles.map((profile) => profile.commandName));
  for (const previousName of readProviderProfileManifest(rootDir)) {
    if (nextNames.has(previousName)) continue;
    try {
      fs.unlinkSync(path.join(rootDir, previousName));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const profile of profiles) {
    writeFileIfChanged(
      path.join(rootDir, profile.commandName),
      buildProviderProfileWrapperScript(profile),
      PRIVATE_EXECUTABLE_FILE_MODE,
    );
  }
  writeFileIfChanged(
    path.join(rootDir, PROVIDER_PROFILE_MANIFEST_FILENAME),
    `${JSON.stringify([...nextNames].toSorted(), null, 2)}\n`,
    PRIVATE_FILE_MODE,
  );
}

function buildManagedZshRc(quotedZshDir: string): string {
  return `# Saint zsh rc wrapper
_saint_home="\${SAINT_ORIGINAL_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_saint_home"
[[ -f "$_saint_home/.zshrc" ]] && source "$_saint_home/.zshrc"
export ZDOTDIR=${quotedZshDir}
if [ -n "\${SAINT_MANAGED_BIN_DIR:-}" ] && [ -d "\${SAINT_MANAGED_BIN_DIR}" ]; then
  case ":$PATH:" in
    *:\${SAINT_MANAGED_BIN_DIR}:*) ;;
    *) export PATH="\${SAINT_MANAGED_BIN_DIR}:$PATH" ;;
  esac
  unalias claude 2>/dev/null || true
  claude() {
    if [ -x "\${SAINT_MANAGED_BIN_DIR}/claude" ] && [ ! -d "\${SAINT_MANAGED_BIN_DIR}/claude" ]; then
      "\${SAINT_MANAGED_BIN_DIR}/claude" "$@"
    else
      command claude "$@"
    fi
  }
  unalias codex 2>/dev/null || true
  codex() {
    if [ -x "\${SAINT_MANAGED_BIN_DIR}/codex" ] && [ ! -d "\${SAINT_MANAGED_BIN_DIR}/codex" ]; then
      "\${SAINT_MANAGED_BIN_DIR}/codex" "$@"
    else
      command codex "$@"
    fi
  }
  typeset -ga precmd_functions 2>/dev/null || true
  _saint_ensure_managed_bin() {
    case ":$PATH:" in
      *:\${SAINT_MANAGED_BIN_DIR}:*) ;;
      *) PATH="\${SAINT_MANAGED_BIN_DIR}:$PATH" ;;
    esac
  }
  {
    precmd_functions=(\${precmd_functions:#_saint_ensure_managed_bin} _saint_ensure_managed_bin)
  } 2>/dev/null || true
fi
`;
}

function ensureManagedZshWrappers(zshDir: string): void {
  ensurePrivateDirectorySync(zshDir);
  const quotedZshDir = shellQuote(zshDir);
  writeFileIfChanged(
    path.join(zshDir, ".zshenv"),
    `# Saint zsh env wrapper
_saint_home="\${SAINT_ORIGINAL_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_saint_home"
[[ -f "$_saint_home/.zshenv" ]] && source "$_saint_home/.zshenv"
export ZDOTDIR=${quotedZshDir}
`,
    PRIVATE_FILE_MODE,
  );
  writeFileIfChanged(
    path.join(zshDir, ".zprofile"),
    `# Saint zsh profile wrapper
_saint_home="\${SAINT_ORIGINAL_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_saint_home"
[[ -f "$_saint_home/.zprofile" ]] && source "$_saint_home/.zprofile"
export ZDOTDIR=${quotedZshDir}
`,
    PRIVATE_FILE_MODE,
  );
  writeFileIfChanged(
    path.join(zshDir, ".zshrc"),
    buildManagedZshRc(quotedZshDir),
    PRIVATE_FILE_MODE,
  );
}

export function prepareManagedTerminalWrappers(options: {
  baseEnv: NodeJS.ProcessEnv;
  profiles?: ReadonlyArray<ManagedTerminalProfile>;
  rootDir: string;
  zshRootDir: string;
}): ManagedTerminalWrapperState {
  if (process.platform === "win32") {
    return {
      binDir: null,
      codexHomeDir: null,
      hookScriptPath: null,
      claudeSettingsPath: null,
      zshDir: null,
      targetPathByCliKind: {},
    };
  }

  const targetPathByCliKind: Partial<Record<ManagedTerminalCliKind, string>> = {};
  for (const cliKind of ["codex", "claude"] as const) {
    const commandName = managedTerminalCommandNameForCliKind(cliKind);
    const targetPath = resolveExecutable(commandName, { env: options.baseEnv });
    if (!targetPath) {
      continue;
    }
    targetPathByCliKind[cliKind] = targetPath;
  }

  if (Object.keys(targetPathByCliKind).length === 0 && (options.profiles?.length ?? 0) === 0) {
    if (fs.existsSync(options.rootDir)) {
      synchronizeProviderProfileWrappers(options.rootDir, []);
    }
    return {
      binDir: null,
      codexHomeDir: null,
      hookScriptPath: null,
      claudeSettingsPath: null,
      zshDir: null,
      targetPathByCliKind,
    };
  }

  ensurePrivateDirectorySync(options.rootDir);
  const codexHomeDir = path.join(options.rootDir, "codex-home");
  const hookScriptPath = path.join(options.rootDir, "notify-hook.sh");
  const claudeSettingsPath = path.join(options.rootDir, "claude-settings.json");
  ensurePrivateDirectorySync(codexHomeDir);
  writeFileIfChanged(hookScriptPath, buildNotifyHookScript(), PRIVATE_EXECUTABLE_FILE_MODE);
  writeFileIfChanged(
    claudeSettingsPath,
    buildClaudeSettingsJson(hookScriptPath),
    PRIVATE_FILE_MODE,
  );
  writeFileIfChanged(
    path.join(codexHomeDir, "hooks.json"),
    buildCodexHooksJson(hookScriptPath),
    PRIVATE_FILE_MODE,
  );
  for (const [cliKind, targetPath] of Object.entries(targetPathByCliKind) as Array<
    [ManagedTerminalCliKind, string]
  >) {
    const wrapperPath = path.join(options.rootDir, managedTerminalCommandNameForCliKind(cliKind));
    writeFileIfChanged(
      wrapperPath,
      buildWrapperScript({
        claudeSettingsPath,
        cliKind,
        codexHomeDir,
        notifyHookPath: hookScriptPath,
        targetPath,
      }),
      PRIVATE_EXECUTABLE_FILE_MODE,
    );
  }
  synchronizeProviderProfileWrappers(options.rootDir, options.profiles ?? []);
  ensureManagedZshWrappers(options.zshRootDir);

  return {
    binDir: options.rootDir,
    codexHomeDir,
    hookScriptPath,
    claudeSettingsPath,
    zshDir: options.zshRootDir,
    targetPathByCliKind,
  };
}

function applyManagedTerminalWrapperEnvState(
  env: NodeJS.ProcessEnv,
  wrapperState: {
    binDir: string | null;
    zshDir: string | null;
  },
): NodeJS.ProcessEnv {
  if (!wrapperState.binDir) {
    return env;
  }

  const envPathKey = envPathKeyFor(env);
  const currentPath = env[envPathKey]?.trim() ?? "";
  const currentEntries = currentPath
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (!currentEntries.includes(wrapperState.binDir)) {
    currentEntries.unshift(wrapperState.binDir);
  }

  return {
    ...env,
    SAINT_MANAGED_BIN_DIR: wrapperState.binDir,
    SAINT_ORIGINAL_ZDOTDIR: env.ZDOTDIR ?? env.HOME ?? "",
    ...(wrapperState.zshDir ? { ZDOTDIR: wrapperState.zshDir } : {}),
    [envPathKey]: currentEntries.join(path.delimiter),
  };
}

export function applyManagedTerminalAgentWrapperEnv(
  env: NodeJS.ProcessEnv,
  wrapperState: {
    binDir: string | null;
    zshDir: string | null;
  },
): NodeJS.ProcessEnv {
  return applyManagedTerminalWrapperEnvState(env, wrapperState);
}

export function prepareManagedTerminalAgentWrappers(options: {
  baseEnv: NodeJS.ProcessEnv;
  profiles?: ReadonlyArray<ManagedTerminalProfile>;
  targetDir: string;
  zshDir: string;
}): ManagedTerminalWrapperState {
  return prepareManagedTerminalWrappers({
    baseEnv: options.baseEnv,
    ...(options.profiles ? { profiles: options.profiles } : {}),
    rootDir: options.targetDir,
    zshRootDir: options.zshDir,
  });
}
