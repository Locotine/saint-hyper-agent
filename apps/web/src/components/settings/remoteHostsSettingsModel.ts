// FILE: remoteHostsSettingsModel.ts
// Purpose: Pure view model for Settings › Remote hosts: host rows and their status copy.
// Layer: Settings UI support
// Exports: remoteHostRows, remoteHostStatus, isRemoteHostBusy, RemoteHostRow

import type {
  DesktopRemoteSshHostState,
  DesktopRemoteSshPhase,
  DesktopRemoteSshState,
} from "@saint/contracts";

export interface RemoteHostRow {
  readonly host: string;
  /** Folder shown to the user; the default when the host has none of its own. */
  readonly remoteRoot: string;
  /** The saved folder, null when the host uses the default. */
  readonly savedRemoteRoot: string | null;
  readonly saved: boolean;
  readonly state: DesktopRemoteSshHostState | null;
}

const PHASE_LABELS: Record<DesktopRemoteSshPhase, string> = {
  idle: "Not connected",
  checking: "Checking the host…",
  uploading: "Uploading Saint…",
  installing: "Installing dependencies…",
  starting: "Starting the server…",
  tunneling: "Opening the SSH tunnel…",
  connected: "Connected",
  // Reuses the tunnel copy: no new visible text until the multi-host UI is approved.
  reconnecting: "Opening the SSH tunnel…",
  stopping: "Stopping the server…",
  error: "Connection failed",
};

const BUSY_PHASES: ReadonlySet<DesktopRemoteSshPhase> = new Set([
  "checking",
  "uploading",
  "installing",
  "starting",
  "tunneling",
  "reconnecting",
  "stopping",
]);

export function isRemoteHostBusy(state: DesktopRemoteSshHostState | null): boolean {
  return state !== null && BUSY_PHASES.has(state.phase);
}

export function remoteHostStatus(state: DesktopRemoteSshHostState | null): string {
  if (!state) return PHASE_LABELS.idle;
  if (state.phase === "connected" && state.localPort) {
    return `Connected · forwarded to 127.0.0.1:${state.localPort}`;
  }
  return PHASE_LABELS[state.phase];
}

/** Saved hosts first (most recent first), then hosts with live state that were forgotten. */
export function remoteHostRows(state: DesktopRemoteSshState): RemoteHostRow[] {
  const byHost = new Map(state.hosts.map((host) => [host.host, host]));
  const rows: RemoteHostRow[] = state.savedHosts.map((saved) => ({
    host: saved.host,
    remoteRoot: saved.remoteRoot ?? state.defaultRemoteRoot,
    savedRemoteRoot: saved.remoteRoot ?? null,
    saved: true,
    state: byHost.get(saved.host) ?? null,
  }));
  for (const host of state.hosts) {
    if (rows.some((row) => row.host === host.host) || host.phase === "idle") continue;
    rows.push({
      host: host.host,
      remoteRoot: host.remoteRoot,
      savedRemoteRoot: host.remoteRoot === state.defaultRemoteRoot ? null : host.remoteRoot,
      saved: false,
      state: host,
    });
  }
  return rows;
}
