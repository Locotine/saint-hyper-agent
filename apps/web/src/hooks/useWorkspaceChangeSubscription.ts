// FILE: useWorkspaceChangeSubscription.ts
// Purpose: Keep Explorer, open files, search results, and Git/Diff panels synced with OS/terminal filesystem changes on local and remote hosts.
// Layer: Web query invalidation hook

import {
  PROJECT_WATCH_WORKSPACE_MAX_DIRECTORIES,
  WS_PROJECT_WORKSPACE_WATCH_CAPABILITY,
  type ProjectWorkspaceChangeEvent,
} from "@saint/contracts";
import { LOCAL_HOST_ID, parseHostId, type HostId } from "@saint/shared/hostId";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { invalidateExplorerDirectories } from "../components/chat/explorerFileDrop";
import { apiFor } from "../hosts/hostApi";
import { hostConnections } from "../hosts/hostConnectionRegistry";
import { refreshGitAfterFileWrite, refreshGitQueriesForCwd } from "../lib/gitReactQuery";
import { subscribeTerminalWorkspaceActivity } from "../lib/workspaceRefreshBus";
import {
  onNativeApiServerCapabilitiesChange,
  readLocalNativeApi,
  readNativeApiServerCapability,
} from "../nativeApi";
import { addHostWsTransportStateListener } from "../wsTransportEvents";

const subscribeWorkspaceWatchCapability = (listener: () => void) =>
  onNativeApiServerCapabilitiesChange(listener);
const readWorkspaceWatchCapability = () =>
  readNativeApiServerCapability(WS_PROJECT_WORKSPACE_WATCH_CAPABILITY);
const readServerWorkspaceWatchCapability = () => false;

const subscribeHostConnections = (listener: () => void) => hostConnections.subscribe(listener);
const readServerHostTransport = () => undefined;

const WORKSPACE_REFRESH_DEBOUNCE_MS = 180;
const FOCUS_REFRESH_MIN_INTERVAL_MS = 1_500;

const EXTRA_PROJECT_FAMILIES = new Set([
  "discover-scripts",
  "search-content",
  "search-local-entries",
  "resolve-out-of-root-file-reference",
  "resolve-workspace-file-reference",
]);

function queryKeyMatchesHost(queryKey: readonly unknown[], hostId: HostId): boolean {
  const last = queryKey.at(-1);
  const trailingHost = typeof last === "string" ? parseHostId(last) : null;
  const queryHostId =
    trailingHost !== null && trailingHost !== LOCAL_HOST_ID ? trailingHost : LOCAL_HOST_ID;
  return queryHostId === hostId;
}

function invalidateExtraWorkspaceProjectQueries(
  queryClient: QueryClient,
  cwd: string,
  hostId: HostId,
): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: ({ queryKey }) =>
      queryKey[0] === "projects" &&
      queryKey[2] === cwd &&
      EXTRA_PROJECT_FAMILIES.has(String(queryKey[1])) &&
      queryKeyMatchesHost(queryKey, hostId),
  });
}

function normalizeWatchedDirectories(
  directories?: ReadonlySet<string> | ReadonlyArray<string>,
): readonly string[] {
  if (!directories) return [];
  const unique = new Set<string>();
  for (const dir of directories) {
    const normalized = dir.trim().replace(/^\/+|\/+$/gu, "");
    if (!normalized || normalized === ".") continue;
    unique.add(normalized);
  }
  return [...unique].toSorted().slice(0, PROJECT_WATCH_WORKSPACE_MAX_DIRECTORIES);
}

export function useWorkspaceChangeSubscription(input: {
  hostId?: HostId;
  cwd: string | null;
  directories?: ReadonlySet<string> | ReadonlyArray<string>;
  watchGit?: boolean;
  enabled?: boolean;
  refreshExplorer?: boolean;
  refreshGit?: boolean;
}): void {
  const queryClient = useQueryClient();
  const hostId = input.hostId ?? LOCAL_HOST_ID;
  const enabled = (input.enabled ?? true) && input.cwd !== null;
  const watchGit = input.watchGit === true;
  const refreshExplorer = input.refreshExplorer ?? true;
  const refreshGit = input.refreshGit ?? watchGit;

  const localCapabilityAvailable = useSyncExternalStore(
    subscribeWorkspaceWatchCapability,
    readWorkspaceWatchCapability,
    readServerWorkspaceWatchCapability,
  );
  const remoteTransport = useSyncExternalStore(
    subscribeHostConnections,
    () => (hostId === LOCAL_HOST_ID ? undefined : hostConnections.peek(hostId)),
    readServerHostTransport,
  );

  const normalizedDirs = normalizeWatchedDirectories(input.directories);
  const directoriesKey = normalizedDirs.join("\0");
  const stableDirectories = useMemo(
    () => (directoriesKey.length > 0 ? directoriesKey.split("\0") : []),
    [directoriesKey],
  );

  useEffect(() => {
    const cwd = input.cwd;
    if (!enabled || !cwd) return;

    let refreshTimer: number | null = null;
    let pendingFullGitRefresh = false;

    const flushRefresh = () => {
      refreshTimer = null;
      const runFullGit = pendingFullGitRefresh;
      pendingFullGitRefresh = false;

      if (refreshExplorer) {
        void invalidateExplorerDirectories(queryClient, cwd, hostId).catch(() => undefined);
        void invalidateExtraWorkspaceProjectQueries(queryClient, cwd, hostId).catch(
          () => undefined,
        );
      }
      if (refreshGit) {
        if (runFullGit) {
          void refreshGitQueriesForCwd(queryClient, cwd, "active-details", "local", hostId).catch(
            () => undefined,
          );
        } else {
          void refreshGitAfterFileWrite(queryClient, cwd, hostId).catch(() => undefined);
        }
      }
    };

    const scheduleRefresh = (options?: { readonly fullGit?: boolean }) => {
      if (options?.fullGit) {
        pendingFullGitRefresh = true;
      }
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      refreshTimer = window.setTimeout(flushRefresh, WORKSPACE_REFRESH_DEBOUNCE_MS);
    };

    const api = hostId === LOCAL_HOST_ID ? readLocalNativeApi() : apiFor(hostId);
    const canWatchStream =
      hostId === LOCAL_HOST_ID
        ? localCapabilityAvailable && typeof api?.projects.onWorkspaceChange === "function"
        : typeof api?.projects.onWorkspaceChange === "function";

    const unsubscribeStream = canWatchStream
      ? api?.projects.onWorkspaceChange?.(
          {
            cwd,
            ...(stableDirectories.length > 0 ? { directories: stableDirectories } : {}),
            ...(watchGit ? { watchGit: true } : {}),
          },
          (event: ProjectWorkspaceChangeEvent) => {
            scheduleRefresh({ fullGit: event.gitChanged });
          },
        )
      : undefined;

    // Revalidate on WS reconnect (local or remote SSH) so changes during disconnects appear.
    let sawOpen = false;
    const unsubscribeTransport = addHostWsTransportStateListener(
      hostId,
      (state) => {
        if (state !== "open") return;
        if (!sawOpen) {
          sawOpen = true;
          return;
        }
        scheduleRefresh({ fullGit: watchGit });
      },
      { replayCurrent: true },
    );

    // Refresh promptly when a terminal in this workspace finishes a command (covers both
    // older remote servers without workspace-watch and deep subdirectories beyond watch cap).
    const unsubscribeTerminal = subscribeTerminalWorkspaceActivity(hostId, cwd, () => {
      scheduleRefresh({ fullGit: watchGit });
    });

    // Focus / visibility fallback catches external OS edits made while away from Saint.
    let lastFocusRefreshAt = 0;
    const triggerFocusRefresh = () => {
      const now = Date.now();
      if (now - lastFocusRefreshAt < FOCUS_REFRESH_MIN_INTERVAL_MS) return;
      lastFocusRefreshAt = now;
      scheduleRefresh({ fullGit: watchGit });
    };
    const handleVisibilityChange = () => {
      if (document.hidden) return;
      triggerFocusRefresh();
    };

    window.addEventListener("focus", triggerFocusRefresh);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      unsubscribeStream?.();
      unsubscribeTransport();
      unsubscribeTerminal();
      window.removeEventListener("focus", triggerFocusRefresh);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    enabled,
    hostId,
    input.cwd,
    localCapabilityAvailable,
    queryClient,
    refreshExplorer,
    refreshGit,
    remoteTransport,
    stableDirectories,
    watchGit,
  ]);
}
