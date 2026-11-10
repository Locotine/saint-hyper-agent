// FILE: remoteHostsSettingsModel.ts
// Purpose: Pure view model for Settings › Remote hosts: host rows and their status copy.
// Layer: Settings UI support
// Exports: remoteHostRows, remoteHostStatus, remoteHostAlias, isRemoteHostBusy,
//          remoteHostStatusTone, remoteHostBadgeLabel, formatRemoteHostConnectionDetails,
//          remoteHostConnectingProgress, RemoteHostRow, RemoteHostStatusTone, RemoteHostBadgeLabel

import { sshHostId, type HostId } from "@saint/shared/hostId";
import type {
  DesktopRemoteSshHostState,
  DesktopRemoteSshPhase,
  DesktopRemoteSshState,
} from "@saint/contracts";

export type RemoteHostStatusTone = "disconnected" | "connecting" | "connected" | "error";
export type RemoteHostBadgeLabel = "Disconnected" | "Connecting…" | "Connected" | "Error";

export interface RemoteHostRow {
  readonly host: string;
  readonly label: string | null;
  readonly displayName: string;
  readonly user: string | null;
  readonly port: number | null;
  readonly identityFile: string | null;
  readonly connectionDetails: string;
  readonly statusTone: RemoteHostStatusTone;
  readonly statusBadge: RemoteHostBadgeLabel;
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

export function remoteHostStatusTone(
  state: DesktopRemoteSshHostState | null,
): RemoteHostStatusTone {
  if (!state || state.phase === "idle") return "disconnected";
  if (state.phase === "connected") return "connected";
  if (state.phase === "error") return "error";
  return "connecting";
}

export function remoteHostBadgeLabel(
  state: DesktopRemoteSshHostState | null,
): RemoteHostBadgeLabel {
  const tone = remoteHostStatusTone(state);
  switch (tone) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "error":
      return "Error";
    case "disconnected":
      return "Disconnected";
  }
}

export function formatRemoteHostConnectionDetails(input: {
  readonly host: string;
  readonly user?: string | null;
  readonly port?: number | null;
  readonly identityFile?: string | null;
}): string {
  const trimmedHost = input.host.trim();
  const atIndex = trimmedHost.indexOf("@");
  const parsedUser = atIndex > 0 ? trimmedHost.slice(0, atIndex) : null;
  const hostAfterAt = atIndex > 0 ? trimmedHost.slice(atIndex + 1) : trimmedHost;
  const colonIndex =
    hostAfterAt.startsWith("[") || !hostAfterAt.includes(":") ? -1 : hostAfterAt.lastIndexOf(":");
  const parsedHostname = colonIndex > 0 ? hostAfterAt.slice(0, colonIndex) : hostAfterAt;
  const parsedPortFromHost =
    colonIndex > 0 ? Number.parseInt(hostAfterAt.slice(colonIndex + 1), 10) : Number.NaN;

  const resolvedUser = input.user?.trim() || parsedUser || "ssh";
  const resolvedPort =
    input.port && input.port > 0
      ? input.port
      : Number.isFinite(parsedPortFromHost) && parsedPortFromHost > 0
        ? parsedPortFromHost
        : 22;
  const resolvedKey = input.identityFile?.trim() || "~/.ssh/id_ed25519";
  return `${resolvedUser}@${parsedHostname}:${resolvedPort} • ${resolvedKey}`;
}

export function remoteHostConnectingProgress(
  row: Pick<RemoteHostRow, "host" | "displayName" | "state">,
): string | null {
  if (!isRemoteHostBusy(row.state)) return null;
  const phaseDetail = remoteHostStatus(row.state);
  return `Setting up a managed Saint server on ${row.displayName} — ${phaseDetail}`;
}

export function remoteHostStatus(state: DesktopRemoteSshHostState | null): string {
  if (!state) return PHASE_LABELS.idle;
  if (state.phase === "connected" && state.localPort) {
    return `Connected · forwarded to 127.0.0.1:${state.localPort}`;
  }
  return PHASE_LABELS[state.phase];
}

/** The name the user gave the host (its ssh alias), or null when no saved or live host has that id. */
export function remoteHostAlias(
  state: DesktopRemoteSshState | null,
  hostId: HostId,
): string | null {
  if (!state) return null;
  const match = [...state.hosts, ...state.savedHosts].find(
    (host) => host.hostKey && sshHostId(host.hostKey) === hostId,
  );
  return match?.host ?? null;
}

/** Saved hosts first (most recent first), then hosts with live state that were forgotten. */
export function remoteHostRows(state: DesktopRemoteSshState): RemoteHostRow[] {
  const byHost = new Map(state.hosts.map((host) => [host.host, host]));
  const rows: RemoteHostRow[] = state.savedHosts.map((saved) => {
    const liveState = byHost.get(saved.host) ?? null;
    const label = saved.label?.trim() || null;
    const user = saved.user?.trim() || null;
    const port = saved.port && saved.port > 0 ? saved.port : null;
    const identityFile = saved.identityFile?.trim() || null;
    return {
      host: saved.host,
      label,
      displayName: label ?? saved.host,
      user,
      port,
      identityFile,
      connectionDetails: formatRemoteHostConnectionDetails({
        host: saved.host,
        user,
        port,
        identityFile,
      }),
      statusTone: remoteHostStatusTone(liveState),
      statusBadge: remoteHostBadgeLabel(liveState),
      remoteRoot: saved.remoteRoot ?? state.defaultRemoteRoot,
      savedRemoteRoot: saved.remoteRoot ?? null,
      saved: true,
      state: liveState,
    };
  });
  for (const host of state.hosts) {
    if (rows.some((row) => row.host === host.host) || host.phase === "idle") continue;
    rows.push({
      host: host.host,
      label: null,
      displayName: host.host,
      user: null,
      port: null,
      identityFile: null,
      connectionDetails: formatRemoteHostConnectionDetails({ host: host.host }),
      statusTone: remoteHostStatusTone(host),
      statusBadge: remoteHostBadgeLabel(host),
      remoteRoot: host.remoteRoot,
      savedRemoteRoot: host.remoteRoot === state.defaultRemoteRoot ? null : host.remoteRoot,
      saved: false,
      state: host,
    });
  }
  return rows;
}
