// FILE: remoteSshIpc.ts
// Purpose: Registers the remote SSH host IPC surface used by Settings › Remote hosts and the sidebar.
// Layer: Desktop IPC (Electron main)
// Exports: registerRemoteSshIpc, RemoteSshIpcOptions

import type {
  DesktopRemoteSshSavedHost,
  DesktopRemoteSshState,
  DesktopWorkspaceDownloadResult,
} from "@saint/contracts";
import { generateHostKey } from "@saint/shared/hostId";
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";

import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import {
  isValidSshTarget,
  normalizeRemoteRoot,
  parseSshConfigHosts,
  rememberRemoteSshHost,
  type SavedRemoteSshHost,
} from "./remoteSshConfig";
import type { RemoteSshManager } from "./remoteSshManager";
import {
  resolveWorkspaceDownloadRequests,
  type WorkspaceDownloadRequest,
} from "./workspaceDownloads";

const IPC = DESKTOP_IPC_CHANNELS.remoteSsh;

export interface RemoteSshIpcOptions {
  /** False on Stable: every channel refuses and the preload exposes nothing. */
  readonly enabled: boolean;
  readonly manager: RemoteSshManager;
  readonly defaultRemoteRoot: string;
  /** Only the app window may drive remote hosts. */
  readonly isControlRenderer: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean;
  readonly readSshConfig: () => string | null;
  readonly readSavedHosts: () => SavedRemoteSshHost[];
  readonly writeSavedHosts: (hosts: readonly SavedRemoteSshHost[]) => void;
  readonly broadcast: (state: DesktopRemoteSshState) => void;
  /** Asks where to save (a Save or folder dialog), then fetches and writes the files. */
  readonly saveDownloads: (
    requests: readonly WorkspaceDownloadRequest[],
  ) => Promise<DesktopWorkspaceDownloadResult>;
}

function parseSavedHostInput(value: unknown): { host: string; remoteRoot: string | null } {
  const host = (value as { host?: unknown } | null)?.host;
  const rawRoot = (value as { remoteRoot?: unknown } | null)?.remoteRoot;
  if (typeof host !== "string" || !isValidSshTarget(host.trim())) {
    throw new Error("Enter an SSH host such as `devbox` or `user@example.com`.");
  }
  if (rawRoot === undefined || rawRoot === null || rawRoot === "") {
    return { host: host.trim(), remoteRoot: null };
  }
  const remoteRoot = typeof rawRoot === "string" ? normalizeRemoteRoot(rawRoot) : null;
  if (!remoteRoot) {
    throw new Error("The remote folder must be a relative path inside the home folder.");
  }
  return { host: host.trim(), remoteRoot };
}

function parseHost(value: unknown): string {
  if (typeof value !== "string" || !isValidSshTarget(value)) {
    throw new Error("Unknown SSH host.");
  }
  return value;
}

export function registerRemoteSshIpc(
  ipcMain: IpcMain,
  options: RemoteSshIpcOptions,
): { readonly publishState: () => void; readonly autoConnectSavedHosts: () => void } {
  const snapshot = (): DesktopRemoteSshState => {
    let configHosts: string[] = [];
    try {
      const contents = options.readSshConfig();
      configHosts = contents ? parseSshConfigHosts(contents) : [];
    } catch {
      configHosts = [];
    }
    return {
      configHosts,
      savedHosts: options.readSavedHosts(),
      hosts: options.manager.states(),
      defaultRemoteRoot: options.defaultRemoteRoot,
    };
  };
  const publishState = () => {
    if (options.enabled) options.broadcast(snapshot());
  };

  ipcMain.removeAllListeners(IPC.enabled);
  ipcMain.on(IPC.enabled, (event: IpcMainEvent) => {
    event.returnValue = options.enabled && options.isControlRenderer(event);
  });

  const handle = (channel: string, action: (payload: unknown) => unknown) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, payload: unknown) => {
      if (!options.enabled) throw new Error("Remote SSH hosts are not available in this build.");
      if (!options.isControlRenderer(event)) throw new Error("Remote SSH access denied.");
      return action(payload);
    });
  };

  handle(IPC.getState, () => snapshot());
  handle(IPC.connect, async (payload) => {
    const input = parseSavedHostInput(payload);
    const [latest, ...older] = rememberRemoteSshHost(options.readSavedHosts(), input);
    // First connect of a host mints its stable key; later connects keep the saved one.
    const hostKey = latest?.hostKey ?? generateHostKey();
    const saved: DesktopRemoteSshSavedHost = {
      host: input.host,
      remoteRoot: input.remoteRoot,
      hostKey,
    };
    options.writeSavedHosts([{ ...input, hostKey }, ...older]);
    publishState();
    return options.manager.connect(saved);
  });
  // Disconnecting or stopping a host is a choice: it stays saved but is not brought back at launch.
  const skipAutoConnect = (host: string) => {
    options.writeSavedHosts(
      options
        .readSavedHosts()
        .map((saved) => (saved.host === host ? { ...saved, autoConnect: false as const } : saved)),
    );
    publishState();
  };
  handle(IPC.disconnect, (payload) => {
    const host = parseHost(payload);
    options.manager.disconnect(host);
    skipAutoConnect(host);
  });
  handle(IPC.stopServer, async (payload) => {
    const input = parseSavedHostInput(payload);
    await options.manager.stopServer(input);
    skipAutoConnect(input.host);
  });
  // The renderer's per-host connections reach a connected host's server here.
  handle(IPC.wsUrl, (payload) => options.manager.wsUrl(parseHost(payload)));
  // Explorer "Download": built from the host's own tunnelled URL, never one the renderer chose.
  handle(IPC.downloadFiles, async (payload) => {
    const input = payload as { host?: unknown; items?: unknown } | null;
    const requests = resolveWorkspaceDownloadRequests(
      input?.items,
      options.manager.wsUrl(parseHost(input?.host)),
    );
    if (!requests) throw new Error("This download request is not valid.");
    if (requests.length === 0) return { canceled: false, saved: [], failures: [] };
    return options.saveDownloads(requests);
  });
  handle(IPC.forget, (payload) => {
    const host = parseHost(payload);
    options.writeSavedHosts(options.readSavedHosts().filter((saved) => saved.host !== host));
    publishState();
  });

  // Reconnects the hosts that were connected when the app last ran, i.e. every saved host the
  // user did not disconnect. A failure shows on that host's row; it never blocks the others.
  const autoConnectSavedHosts = () => {
    if (!options.enabled) return;
    const saved = options.readSavedHosts();
    const targets = saved.filter((entry) => entry.autoConnect !== false);
    if (targets.length === 0) return;
    const keyed = saved.map((entry) => ({ ...entry, hostKey: entry.hostKey ?? generateHostKey() }));
    if (keyed.some((entry, index) => entry.hostKey !== saved[index]?.hostKey)) {
      options.writeSavedHosts(keyed);
    }
    for (const entry of keyed) {
      if (entry.autoConnect === false) continue;
      void options.manager
        .connect({ host: entry.host, remoteRoot: entry.remoteRoot, hostKey: entry.hostKey })
        .catch(() => undefined);
    }
    publishState();
  };

  return { publishState, autoConnectSavedHosts };
}
