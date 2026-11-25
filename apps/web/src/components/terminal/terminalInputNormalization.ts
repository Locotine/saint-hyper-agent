// FILE: terminalInputNormalization.ts
// Purpose: Normalizes non-breaking space characters on terminal input into ASCII spaces.
// Layer: Terminal runtime utility
// Exports: normalizeTerminalInputData

// Non-breaking space variants (e.g. Shift/Alt+Space on XKB/macOS, IME commits, or HTML/chat
// clipboard pastes) render identically to ASCII space in xterm.js but break POSIX shell word
// splitting (`bash: git\u00a0pull: command not found`, while xterm selection silently rewrites
// U+00A0 back to 0x20). Normalize them to standard ASCII space before writing to the PTY.
const NON_BREAKING_TERMINAL_SPACES_PATTERN = /[\u00a0\u2007\u202f]/g;

export function normalizeTerminalInputData(data: string): string {
  return NON_BREAKING_TERMINAL_SPACES_PATTERN.test(data)
    ? data.replace(NON_BREAKING_TERMINAL_SPACES_PATTERN, " ")
    : data;
}
