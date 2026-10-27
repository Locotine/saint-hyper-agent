// FILE: remoteSshEditors.ts
// Purpose: Builds "Open in editor" links for remote SSH windows. A remote host's
//          paths only exist on that host, so editors with a Remote-SSH mode open
//          them through the local editor instead of launching one on the host.
// Layer: Desktop remote SSH utility
// Exports: REMOTE_SSH_EDITOR_IDS, buildRemoteSshEditorUrl

import type { EditorId } from "@saint/contracts";

/** URL scheme of each editor that opens `vscode-remote://ssh-remote+<host>` folders. */
const REMOTE_SSH_EDITOR_SCHEMES = {
  vscode: "vscode",
  "vscode-insiders": "vscode-insiders",
  cursor: "cursor",
  windsurf: "windsurf",
  vscodium: "vscodium",
} as const satisfies Partial<Record<EditorId, string>>;

type RemoteSshEditorId = keyof typeof REMOTE_SSH_EDITOR_SCHEMES;

export const REMOTE_SSH_EDITOR_IDS = Object.keys(
  REMOTE_SSH_EDITOR_SCHEMES,
) as readonly RemoteSshEditorId[];

function isRemoteSshEditorId(value: string): value is RemoteSshEditorId {
  return Object.hasOwn(REMOTE_SSH_EDITOR_SCHEMES, value);
}

/**
 * `<scheme>://vscode-remote/ssh-remote+<host><path>[:line[:column]]`, or null
 * when the editor has no Remote-SSH mode or the target is not an absolute
 * POSIX path. A trailing `:line[:column]` (the server's goto form) is kept
 * so the editor jumps to it.
 */
export function buildRemoteSshEditorUrl(input: {
  readonly host: string;
  readonly editor: string;
  readonly target: string;
}): string | null {
  if (!isRemoteSshEditorId(input.editor)) return null;
  const match = /^(\/.*?)((?::\d+){0,2})$/u.exec(input.target.trim());
  const path = match?.[1];
  if (!path || path.includes("\0")) return null;
  const encodedPath = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const scheme = REMOTE_SSH_EDITOR_SCHEMES[input.editor];
  return `${scheme}://vscode-remote/ssh-remote+${encodeURIComponent(input.host)}${encodedPath}${match[2] ?? ""}`;
}
