import type {
  ComputerProvisionResult,
  NativeApi,
  ProviderKind,
  ServerConfig,
  ServerConsumeCodexResetCreditInput,
  ServerListProviderUsageInput,
  ServerProviderStatus,
  ServerStopLocalServerInput,
  StatsGetRecapInput,
  ThreadId,
} from "@saint/contracts";
import { LOCAL_HOST_ID, type HostId } from "@saint/shared/hostId";
import { apiFor } from "../hosts/hostApi";
import { projectApiFor, withHostKey } from "./projectReactQuery";
import { hasProbedEnabledProviderStatuses } from "./providerAvailability";
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { ensureLocalNativeApi } from "~/nativeApi";
import { EXPENSIVE_READ_RETRY_OPTIONS } from "./expensiveReadRetry";

export const LOCAL_SERVERS_VISIBLE_REFETCH_INTERVAL_MS = 10_000;
const LOCAL_SERVERS_DEFAULT_STALE_TIME_MS = 3_000;

export const serverQueryKeys = {
  all: ["server"] as const,
  config: () => ["server", "config"] as const,
  authSession: () => ["server", "auth", "session"] as const,
  environment: () => ["server", "environment"] as const,
  settings: () => ["server", "settings"] as const,
  worktrees: () => ["server", "worktrees"] as const,
  localServers: () => ["server", "localServers"] as const,
  // Another host's usage never shares a cache entry with this computer's: its key ends in the
  // host id, while this computer's keeps its original shape.
  providerUsage: (
    provider: ProviderKind | null | undefined,
    homePath?: string | null,
    hostId: HostId = LOCAL_HOST_ID,
  ) =>
    hostId === LOCAL_HOST_ID
      ? (["server", "providerUsage", provider ?? null, homePath ?? null] as const)
      : (["server", "providerUsage", provider ?? null, homePath ?? null, hostId] as const),
  providerUsageRoot: () => ["server", "providerUsage"] as const,
  allProviderUsage: (hostId: HostId = LOCAL_HOST_ID) =>
    hostId === LOCAL_HOST_ID
      ? (["server", "allProviderUsage"] as const)
      : (["server", "allProviderUsage", hostId] as const),
  profileStats: (utcOffsetMinutes: number) =>
    ["server", "profileStats", "peak-hour-v2", utcOffsetMinutes] as const,
  profileTokenStats: (utcOffsetMinutes: number) =>
    ["server", "profileTokenStats", utcOffsetMinutes] as const,
  recap: (input: StatsGetRecapInput) =>
    ["server", "recap", input.from, input.to, input.slotBoundaries.join(",")] as const,
  studioThreadOutputs: (threadId: ThreadId | null) =>
    ["server", "studioThreadOutputs", threadId] as const,
  computerStatus: () => ["server", "computerStatus"] as const,
  computerAuditHistory: () => ["server", "computerAuditHistory"] as const,
};

export const serverMutationKeys = {
  stopLocalServer: () => ["server", "mutation", "stopLocalServer"] as const,
};

export function serverConfigQueryOptions(hostId: HostId = LOCAL_HOST_ID) {
  return queryOptions({
    queryKey: withHostKey(serverQueryKeys.config(), hostId),
    queryFn: async ({ client }) => {
      const api = projectApiFor(hostId);
      const config = await api.server.getConfig();
      if (hostId === LOCAL_HOST_ID) {
        return config;
      }
      const latest = latestRemoteProviderStatusSnapshotsByQueryClient.get(client)?.get(hostId);
      if (!latest || latest.providers.length === 0) {
        return config;
      }
      return {
        ...config,
        providers: mergeRemoteProviderStatusSnapshots(config.providers, latest.providers),
      };
    },
    // This computer's config is kept current by its stream; a host's is kept current by
    // connect refresh + provider status stream and still allows periodic resyncs.
    staleTime: hostId === LOCAL_HOST_ID ? Infinity : 30_000,
  });
}

/** Polled while the Computer use settings panel is visible, so keep it refetchable. */
export const COMPUTER_STATUS_VISIBLE_REFETCH_INTERVAL_MS = 10_000;

export function computerStatusQueryOptions() {
  return queryOptions({
    queryKey: serverQueryKeys.computerStatus(),
    queryFn: async () => {
      const api = ensureLocalNativeApi();
      // Desktop-bridge NativeApi implementations update out of band and may
      // predate the computer namespace.
      if (!api.computer) {
        throw new Error("This app build cannot read computer status.");
      }
      return api.computer.getStatus({});
    },
    staleTime: LOCAL_SERVERS_DEFAULT_STALE_TIME_MS,
  });
}

/** Share one setup request across the settings panel and transcript cards. */
let computerProvisionInFlight: Promise<ComputerProvisionResult> | undefined;
export function provisionComputer(): Promise<ComputerProvisionResult> {
  if (computerProvisionInFlight) return computerProvisionInFlight;
  const api = ensureLocalNativeApi();
  if (!api.computer?.provision)
    return Promise.reject(new Error("This app build cannot set up computer control."));
  computerProvisionInFlight = api.computer.provision({}).finally(() => {
    computerProvisionInFlight = undefined;
  });
  return computerProvisionInFlight;
}

interface ProviderStatusSnapshot {
  readonly revision: number;
  readonly providers: readonly ServerProviderStatus[];
  readonly reconciled: boolean;
}

const latestProviderStatusSnapshotByQueryClient = new WeakMap<
  QueryClient,
  ProviderStatusSnapshot
>();
const latestRemoteProviderStatusSnapshotsByQueryClient = new WeakMap<
  QueryClient,
  Map<HostId, ProviderStatusSnapshot>
>();

const configRefreshRevisionByQueryClient = new WeakMap<QueryClient, number>();
const providerConfigHydrationByQueryClient = new WeakMap<QueryClient, Promise<ServerConfig>>();
const remoteProviderConfigHydrationByQueryClient = new WeakMap<
  QueryClient,
  Map<HostId, Promise<ServerConfig>>
>();
const inFlightRemoteProviderRefreshByHostId = new Map<
  HostId,
  Promise<readonly ServerProviderStatus[] | null>
>();

function getRemoteSnapshotMap(queryClient: QueryClient): Map<HostId, ProviderStatusSnapshot> {
  let map = latestRemoteProviderStatusSnapshotsByQueryClient.get(queryClient);
  if (!map) {
    map = new Map();
    latestRemoteProviderStatusSnapshotsByQueryClient.set(queryClient, map);
  }
  return map;
}

function getRemoteHydrationMap(queryClient: QueryClient): Map<HostId, Promise<ServerConfig>> {
  let map = remoteProviderConfigHydrationByQueryClient.get(queryClient);
  if (!map) {
    map = new Map();
    remoteProviderConfigHydrationByQueryClient.set(queryClient, map);
  }
  return map;
}

/**
 * Merges two remote status snapshots without letting an unprobed pre-refresh
 * projection (which contains only disabled non-allowlisted providers) drop
 * probed enabled providers from the other snapshot.
 */
function mergeRemoteProviderStatusSnapshots(
  base: readonly ServerProviderStatus[] | undefined,
  incoming: readonly ServerProviderStatus[],
): readonly ServerProviderStatus[] {
  if (!base || base.length === 0) {
    return incoming;
  }
  if (hasProbedEnabledProviderStatuses(base) && !hasProbedEnabledProviderStatuses(incoming)) {
    return mergeProviderStatusSnapshots(incoming, base);
  }
  return mergeProviderStatusSnapshots(base, incoming);
}

export function hasReconciledServerProviderStatuses(
  queryClient: QueryClient,
  hostId: HostId = LOCAL_HOST_ID,
): boolean {
  if (hostId === LOCAL_HOST_ID) {
    return latestProviderStatusSnapshotByQueryClient.get(queryClient)?.reconciled === true;
  }
  const snapshot = latestRemoteProviderStatusSnapshotsByQueryClient.get(queryClient)?.get(hostId);
  if (snapshot !== undefined) {
    return snapshot.reconciled;
  }
  const cached = queryClient.getQueryData<ServerConfig>(
    withHostKey(serverQueryKeys.config(), hostId),
  );
  return hasProbedEnabledProviderStatuses(cached?.providers);
}

export function markRemoteHostProviderStatusesStale(
  queryClient: QueryClient,
  hostId: HostId,
): void {
  if (hostId === LOCAL_HOST_ID) return;
  inFlightRemoteProviderRefreshByHostId.delete(hostId);
  const snapshots = latestRemoteProviderStatusSnapshotsByQueryClient.get(queryClient);
  const current = snapshots?.get(hostId);
  if (current) {
    snapshots?.set(hostId, { ...current, reconciled: false });
  }
}

export function clearRemoteHostProviderStatusState(queryClient: QueryClient, hostId: HostId): void {
  if (hostId === LOCAL_HOST_ID) return;
  inFlightRemoteProviderRefreshByHostId.delete(hostId);
  latestRemoteProviderStatusSnapshotsByQueryClient.get(queryClient)?.delete(hostId);
  remoteProviderConfigHydrationByQueryClient.get(queryClient)?.delete(hostId);
  queryClient.removeQueries({ queryKey: withHostKey(serverQueryKeys.config(), hostId) });
}

export async function awaitInFlightRemoteHostProviderRefresh(
  hostId: HostId,
): Promise<readonly ServerProviderStatus[] | null> {
  if (hostId === LOCAL_HOST_ID) return null;
  const inFlight = inFlightRemoteProviderRefreshByHostId.get(hostId);
  if (!inFlight) return null;
  return inFlight.catch(() => null);
}

function providerStatusIdentity(
  status: Pick<ServerProviderStatus, "provider" | "driver" | "instanceId">,
): string {
  const driver = status.driver ?? status.provider;
  return `${driver}:${status.instanceId ?? status.provider}`;
}

function mergeProviderStatusSnapshots(
  previous: readonly ServerProviderStatus[] | undefined,
  next: readonly ServerProviderStatus[],
): readonly ServerProviderStatus[] {
  if (!previous || previous.length === 0) {
    return next;
  }

  const previousByIdentity = new Map(
    previous.map((status) => [providerStatusIdentity(status), status]),
  );
  return next.map((status) => {
    const prior = previousByIdentity.get(providerStatusIdentity(status));
    if (!prior) {
      return status;
    }

    // Provider refreshes can overlap: a slow initial Pi probe may publish its
    // warning after the fast recovery probe has already published ready.
    // checkedAt is stamped when each probe begins, so never let an older
    // snapshot resurrect a stale banner/toast in the web cache.
    const priorCheckedAt = Date.parse(prior.checkedAt);
    const nextCheckedAt = Date.parse(status.checkedAt);
    return Number.isFinite(priorCheckedAt) &&
      Number.isFinite(nextCheckedAt) &&
      nextCheckedAt < priorCheckedAt
      ? prior
      : status;
  });
}

function recordProviderStatusSnapshot(
  queryClient: QueryClient,
  providers: readonly ServerProviderStatus[],
): ProviderStatusSnapshot {
  const previous = latestProviderStatusSnapshotByQueryClient.get(queryClient);
  const snapshot = {
    revision: (previous?.revision ?? 0) + 1,
    providers: mergeProviderStatusSnapshots(previous?.providers, providers),
    reconciled: true,
  };
  latestProviderStatusSnapshotByQueryClient.set(queryClient, snapshot);
  return snapshot;
}

/**
 * Folds an authoritative provider snapshot into server.config. Provider streams
 * can win the race against the initial config query, so retain the latest
 * snapshot and apply it after config hydration instead of dropping it.
 */
export async function reconcileServerProviderStatuses(
  queryClient: QueryClient,
  providers: readonly ServerProviderStatus[],
  options?: {
    readonly loadConfig?: () => Promise<ServerConfig>;
  },
): Promise<void> {
  const currentConfig = queryClient.getQueryData<ServerConfig>(serverQueryKeys.config());
  const snapshot = recordProviderStatusSnapshot(queryClient, providers);
  const effectiveProviders = mergeProviderStatusSnapshots(
    currentConfig?.providers,
    snapshot.providers,
  );
  if (effectiveProviders !== snapshot.providers) {
    latestProviderStatusSnapshotByQueryClient.set(queryClient, {
      ...snapshot,
      providers: effectiveProviders,
    });
  }

  let applied = false;
  queryClient.setQueryData<ServerConfig>(serverQueryKeys.config(), (current) => {
    if (!current) return current;
    applied = true;
    return {
      ...current,
      providers: mergeProviderStatusSnapshots(current.providers, effectiveProviders),
    };
  });
  if (applied) return;

  const loadConfig =
    options?.loadConfig ??
    (async () => {
      const inFlight = providerConfigHydrationByQueryClient.get(queryClient);
      if (inFlight) return inFlight;
      // Coalesce initial stream hydration without fetchQuery's automatic cache
      // write, which would erase a newer cache writer before reconciliation.
      const request = ensureLocalNativeApi().server.getConfig();
      providerConfigHydrationByQueryClient.set(queryClient, request);
      try {
        return await request;
      } finally {
        providerConfigHydrationByQueryClient.delete(queryClient);
      }
    });
  const hydratedConfig = await loadConfig();
  const latestSnapshot = latestProviderStatusSnapshotByQueryClient.get(queryClient) ?? snapshot;
  queryClient.setQueryData<ServerConfig>(serverQueryKeys.config(), (current) => {
    // Hydration and another cache writer may both know about a newer probe.
    // Keep stream membership, but choose the freshest status for each instance.
    const reconciledProviders = mergeProviderStatusSnapshots(
      current?.providers,
      mergeProviderStatusSnapshots(hydratedConfig.providers, latestSnapshot.providers),
    );
    latestProviderStatusSnapshotByQueryClient.set(queryClient, {
      ...latestSnapshot,
      providers: reconciledProviders,
    });
    return { ...(current ?? hydratedConfig), providers: reconciledProviders };
  });
}

/**
 * Refreshes the config projection when the WebSocket reopens without letting
 * the response overwrite a provider snapshot that arrived while it was in flight.
 */
export async function refreshServerConfigAfterTransportOpen(
  queryClient: QueryClient,
  options?: {
    readonly loadConfig?: () => Promise<ServerConfig>;
  },
): Promise<void> {
  const configRefreshRevision = (configRefreshRevisionByQueryClient.get(queryClient) ?? 0) + 1;
  configRefreshRevisionByQueryClient.set(queryClient, configRefreshRevision);
  const providerSnapshotAtStart = latestProviderStatusSnapshotByQueryClient.get(queryClient);
  const configSnapshotAtStart = queryClient.getQueryData<ServerConfig>(serverQueryKeys.config());
  const providerRevisionAtStart = providerSnapshotAtStart?.revision ?? 0;
  latestProviderStatusSnapshotByQueryClient.set(queryClient, {
    revision: providerRevisionAtStart,
    providers: providerSnapshotAtStart?.providers ?? [],
    reconciled: false,
  });
  // A reconnect must issue a fresh projection read. fetchQuery can share an
  // older in-flight request and write its stale membership before we reconcile.
  const loadConfig = options?.loadConfig ?? (() => ensureLocalNativeApi().server.getConfig());
  const config = await loadConfig();
  if (configRefreshRevisionByQueryClient.get(queryClient) !== configRefreshRevision) return;
  const latestProviderSnapshot = latestProviderStatusSnapshotByQueryClient.get(queryClient);
  const streamArrivedDuringRefresh =
    latestProviderSnapshot?.reconciled === true &&
    latestProviderSnapshot.revision > providerRevisionAtStart;
  const currentConfig = queryClient.getQueryData<ServerConfig>(serverQueryKeys.config());
  const providers = mergeProviderStatusSnapshots(
    configSnapshotAtStart?.providers,
    mergeProviderStatusSnapshots(
      currentConfig?.providers,
      streamArrivedDuringRefresh
        ? mergeProviderStatusSnapshots(config.providers, latestProviderSnapshot.providers)
        : mergeProviderStatusSnapshots(providerSnapshotAtStart?.providers, config.providers),
    ),
  );
  // A configuration refresh can be newer than the last stream event. Retain
  // its statuses too, without pretending a fresh stream snapshot has arrived.
  latestProviderStatusSnapshotByQueryClient.set(queryClient, {
    revision: latestProviderSnapshot?.revision ?? providerRevisionAtStart,
    providers,
    reconciled: streamArrivedDuringRefresh,
  });
  queryClient.setQueryData<ServerConfig>(serverQueryKeys.config(), {
    ...config,
    providers,
  });
}

/**
 * Folds a remote host's provider status snapshot into its cached `server.config`.
 * Remote hosts receive provider-status pushes and connect-time refreshes before
 * any thread opens, so hydrate the host's config instead of dropping early updates.
 */
export async function reconcileRemoteHostProviderStatuses(
  queryClient: QueryClient,
  hostId: HostId,
  providers: readonly ServerProviderStatus[],
  options?: {
    readonly loadConfig?: () => Promise<ServerConfig>;
  },
): Promise<void> {
  if (hostId === LOCAL_HOST_ID) {
    await reconcileServerProviderStatuses(queryClient, providers, options);
    return;
  }
  const key = withHostKey(serverQueryKeys.config(), hostId);
  const snapshots = getRemoteSnapshotMap(queryClient);
  const previous = snapshots.get(hostId);
  const currentConfig = queryClient.getQueryData<ServerConfig>(key);
  const mergedWithPrevious = mergeRemoteProviderStatusSnapshots(previous?.providers, providers);
  const effectiveProviders = mergeRemoteProviderStatusSnapshots(
    currentConfig?.providers,
    mergedWithPrevious,
  );
  const reconciled =
    hasProbedEnabledProviderStatuses(providers) ||
    (previous?.reconciled === true && hasProbedEnabledProviderStatuses(effectiveProviders));
  const snapshot: ProviderStatusSnapshot = {
    revision: (previous?.revision ?? 0) + 1,
    providers: effectiveProviders,
    reconciled,
  };
  snapshots.set(hostId, snapshot);

  let applied = false;
  queryClient.setQueryData<ServerConfig>(key, (current) => {
    if (!current) return current;
    applied = true;
    return {
      ...current,
      providers: mergeRemoteProviderStatusSnapshots(current.providers, effectiveProviders),
    };
  });
  if (applied) return;

  const remoteApi = options?.loadConfig ? null : apiFor(hostId);
  if (!options?.loadConfig && !remoteApi) {
    void queryClient.invalidateQueries({ queryKey: key });
    return;
  }

  const loadConfig =
    options?.loadConfig ??
    (async () => {
      const hydrations = getRemoteHydrationMap(queryClient);
      const inFlight = hydrations.get(hostId);
      if (inFlight) return inFlight;
      const request = remoteApi!.server.getConfig();
      hydrations.set(hostId, request);
      try {
        return await request;
      } finally {
        if (hydrations.get(hostId) === request) {
          hydrations.delete(hostId);
        }
      }
    });

  const hydratedConfig = await loadConfig();
  // Do not resurrect cache state if the host was forgotten while hydration was in flight.
  const latestSnapshot = snapshots.get(hostId);
  if (!latestSnapshot) return;

  queryClient.setQueryData<ServerConfig>(key, (current) => {
    const reconciledProviders = mergeRemoteProviderStatusSnapshots(
      current?.providers,
      mergeRemoteProviderStatusSnapshots(hydratedConfig.providers, latestSnapshot.providers),
    );
    snapshots.set(hostId, {
      ...latestSnapshot,
      providers: reconciledProviders,
      reconciled:
        latestSnapshot.reconciled || hasProbedEnabledProviderStatuses(reconciledProviders),
    });
    return { ...(current ?? hydratedConfig), providers: reconciledProviders };
  });
}

/**
 * Triggers a live provider-health refresh on a connected remote host, coalesced
 * per host, and reconciles the result into the host's cached server config.
 */
export async function refreshRemoteHostProviderStatuses(
  queryClient: QueryClient,
  hostId: HostId,
  options?: {
    readonly api?: NativeApi;
    readonly isCurrent?: () => boolean;
  },
): Promise<readonly ServerProviderStatus[] | null> {
  if (hostId === LOCAL_HOST_ID) {
    return null;
  }
  const existing = inFlightRemoteProviderRefreshByHostId.get(hostId);
  if (existing) {
    return existing;
  }
  const api = options?.api ?? apiFor(hostId);
  if (!api?.server.refreshProviders) {
    return null;
  }
  const isCurrent = options?.isCurrent ?? (() => true);
  const request = api.server
    .refreshProviders()
    .then(async (result) => {
      if (!isCurrent()) {
        return null;
      }
      await reconcileRemoteHostProviderStatuses(queryClient, hostId, result.providers, {
        loadConfig: () => api.server.getConfig(),
      });
      return result.providers;
    })
    .catch(() => null)
    .finally(() => {
      if (inFlightRemoteProviderRefreshByHostId.get(hostId) === request) {
        inFlightRemoteProviderRefreshByHostId.delete(hostId);
      }
    });
  inFlightRemoteProviderRefreshByHostId.set(hostId, request);
  return request;
}

export function serverAuthSessionQueryOptions() {
  return queryOptions({
    queryKey: serverQueryKeys.authSession(),
    queryFn: async () => {
      const api = ensureLocalNativeApi();
      return api.server.getAuthSession();
    },
    staleTime: 15_000,
  });
}

/**
 * The execution environment (OS, arch, server version) is fixed for the life of
 * a server process, so it caches indefinitely; a restart drops the socket and
 * remounts the app, which refetches.
 */
/** A connected host's environment (its OS) when `hostId` names one; this computer's otherwise. */
export function serverEnvironmentQueryOptions(hostId: HostId = LOCAL_HOST_ID) {
  return queryOptions({
    queryKey:
      hostId === LOCAL_HOST_ID
        ? serverQueryKeys.environment()
        : ([...serverQueryKeys.environment(), hostId] as const),
    queryFn: async () => {
      const api = hostId === LOCAL_HOST_ID ? ensureLocalNativeApi() : apiFor(hostId);
      if (!api) throw new Error("This host is not connected.");
      return api.server.getEnvironment();
    },
    staleTime: Infinity,
  });
}

export function serverSettingsQueryOptions() {
  return queryOptions({
    queryKey: serverQueryKeys.settings(),
    queryFn: async () => {
      const api = ensureLocalNativeApi();
      return api.server.getSettings();
    },
    staleTime: Infinity,
  });
}

export function serverWorktreesQueryOptions() {
  return queryOptions({
    queryKey: serverQueryKeys.worktrees(),
    queryFn: async () => {
      const api = ensureLocalNativeApi();
      return api.server.listWorktrees();
    },
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function serverLocalServersQueryOptions(
  input:
    | boolean
    | {
        enabled?: boolean;
        refetchInterval?: number | false;
        staleTime?: number;
        // The machine whose listening servers are listed; this computer by default.
        hostId?: HostId;
      } = true,
) {
  const options = typeof input === "boolean" ? { enabled: input } : input;
  const enabled = options.enabled ?? true;
  const hostId = options.hostId ?? LOCAL_HOST_ID;
  return queryOptions({
    queryKey: withHostKey(serverQueryKeys.localServers(), hostId),
    queryFn: async () => {
      const api = usageApi(hostId);
      return api.server.listLocalServers();
    },
    enabled,
    staleTime: options.staleTime ?? LOCAL_SERVERS_DEFAULT_STALE_TIME_MS,
    refetchInterval: enabled
      ? (options.refetchInterval ?? LOCAL_SERVERS_VISIBLE_REFETCH_INTERVAL_MS)
      : false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

// Sidebar project badges need a snapshot, but idle Home should not keep shelling out
// through lsof/ps; active Saint-owned runs still poll for responsive status.
export function sidebarLocalServersQueryOptions(input: {
  hasActiveProjectRun: boolean;
  hasProjects: boolean;
}) {
  const enabled = input.hasProjects || input.hasActiveProjectRun;
  return serverLocalServersQueryOptions({
    enabled,
    refetchInterval: input.hasActiveProjectRun ? LOCAL_SERVERS_VISIBLE_REFETCH_INTERVAL_MS : false,
  });
}

const STUDIO_THREAD_OUTPUTS_STALE_TIME_MS = 10_000;

/**
 * Outbox files attributed server-side to one Studio chat. Domain events invalidate this
 * query after checkpoint and non-Git file-change updates.
 */
export function studioThreadOutputsQueryOptions(input: {
  threadId: ThreadId | null;
  enabled?: boolean;
  hostId?: HostId;
}) {
  const threadId = input.threadId;
  const hostId = input.hostId ?? LOCAL_HOST_ID;
  return queryOptions({
    queryKey: withHostKey(serverQueryKeys.studioThreadOutputs(threadId), hostId),
    queryFn: async () => {
      const api = projectApiFor(hostId);
      if (!threadId) {
        return { entries: [] };
      }
      return api.studio.listThreadOutputs({ threadId });
    },
    enabled: (input.enabled ?? true) && threadId !== null,
    staleTime: STUDIO_THREAD_OUTPUTS_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    ...EXPENSIVE_READ_RETRY_OPTIONS,
  });
}

export function serverStopLocalServerMutationOptions(input: {
  queryClient: QueryClient;
  hostId?: HostId;
}) {
  const hostId = input.hostId ?? LOCAL_HOST_ID;
  return mutationOptions({
    mutationKey: serverMutationKeys.stopLocalServer(),
    mutationFn: async (server: ServerStopLocalServerInput) => {
      const api = usageApi(hostId);
      return api.server.stopLocalServer(server);
    },
    onSettled: () => {
      void input.queryClient.invalidateQueries({ queryKey: serverQueryKeys.localServers() });
    },
  });
}

/** This computer's API, or a connected host's; throws while that host has no live connection. */
function usageApi(hostId: HostId) {
  const api = hostId === LOCAL_HOST_ID ? ensureLocalNativeApi() : apiFor(hostId);
  if (!api) throw new Error("This host is not connected.");
  return api;
}

export function serverProviderUsageSnapshotQueryOptions(input: {
  provider: ProviderKind | null | undefined;
  homePath?: string | null;
  enabled?: boolean;
  hostId?: HostId;
}) {
  const hostId = input.hostId ?? LOCAL_HOST_ID;
  return queryOptions({
    queryKey: serverQueryKeys.providerUsage(input.provider, input.homePath, hostId),
    enabled: (input.enabled ?? true) && input.provider !== null && input.provider !== undefined,
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async () => {
      if (!input.provider) return null;
      return usageApi(hostId).server.getProviderUsageSnapshot({
        provider: input.provider,
        ...(input.homePath ? { homePath: input.homePath } : {}),
      });
    },
  });
}

export async function fetchAllProviderUsage(
  input: ServerListProviderUsageInput = {},
  hostId: HostId = LOCAL_HOST_ID,
) {
  return usageApi(hostId).server.listProviderUsage(input);
}

export async function consumeCodexResetCredit(
  input: ServerConsumeCodexResetCreditInput,
  hostId: HostId = LOCAL_HOST_ID,
) {
  return usageApi(hostId).server.consumeCodexResetCredit(input);
}

/** Provider enablement changes alter the membership of the batch and invalidate any
 * provider-scoped result that may otherwise survive after a provider is disabled. */
export async function invalidateProviderUsageQueries(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: serverQueryKeys.allProviderUsage() }),
    queryClient.invalidateQueries({ queryKey: serverQueryKeys.providerUsageRoot() }),
  ]);
}

// Local profile + shareable-card core statistics. The client passes its own fixed
// UTC offset; all metrics are computed from Saint's local DB projections.
export function serverProfileStatsQueryOptions(input: { enabled?: boolean } = {}) {
  const utcOffsetMinutes = -new Date().getTimezoneOffset();
  return queryOptions({
    queryKey: serverQueryKeys.profileStats(utcOffsetMinutes),
    enabled: input.enabled ?? true,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async () => {
      const api = ensureLocalNativeApi();
      return api.stats.getProfileStats({
        utcOffsetMinutes,
      });
    },
  });
}

// DB-backed token totals and token heatmap, split from core stats so the Profile
// page can paint first and upgrade token-only surfaces later.
export function serverProfileTokenStatsQueryOptions(input: { enabled?: boolean } = {}) {
  const utcOffsetMinutes = -new Date().getTimezoneOffset();
  return queryOptions({
    queryKey: serverQueryKeys.profileTokenStats(utcOffsetMinutes),
    enabled: input.enabled ?? true,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async () => {
      const api = ensureLocalNativeApi();
      return api.stats.getProfileTokenStats({
        utcOffsetMinutes,
      });
    },
  });
}

// Inbox recap of one window (a working day and its slots), from Saint's local DB. A recap
// generated after its window ended is final and stays fresh. Anything earlier is refetched,
// including yesterday's entry when it is the one "today" left behind after the day rolled
// over (same window, same key). The current window refreshes while the Inbox is open.
export function serverRecapQueryOptions(
  input: StatsGetRecapInput,
  options: { enabled?: boolean; live?: boolean } = {},
) {
  const live = options.live ?? true;
  const windowEndMs = Date.parse(input.to);
  return queryOptions({
    queryKey: serverQueryKeys.recap(input),
    enabled: options.enabled ?? true,
    staleTime: (query) => {
      const generatedAtMs = Date.parse(query.state.data?.generatedAt ?? "");
      if (generatedAtMs >= windowEndMs) return Number.POSITIVE_INFINITY;
      return live ? 60_000 : 0;
    },
    // Opening the Inbox always shows today's latest numbers.
    refetchOnMount: live ? "always" : true,
    refetchInterval: live ? 5 * 60_000 : false,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async () => ensureLocalNativeApi().stats.getRecap(input),
  });
}

// Live remaining-usage for every provider. Always fetches the full batch under a single query
// key so every surface (settings panel, header chips, branch toolbar) shares one cache entry
// and one request cycle; the server caches per-account snapshots, so the batch is cheap.
export function serverAllProviderUsageQueryOptions(
  input:
    | boolean
    | {
        enabled?: boolean;
        hostId?: HostId;
      } = true,
) {
  const enabled = typeof input === "boolean" ? input : (input.enabled ?? true);
  const hostId = typeof input === "boolean" ? LOCAL_HOST_ID : (input.hostId ?? LOCAL_HOST_ID);
  return queryOptions({
    queryKey: serverQueryKeys.allProviderUsage(hostId),
    enabled,
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async () => fetchAllProviderUsage({}, hostId),
  });
}
