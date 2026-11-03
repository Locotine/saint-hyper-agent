// FILE: flowQueryOptions.ts
// Purpose: React Query keys and options for the HyperAgent RPCs: flows, the ledger, SAP, Aegis
//          and host economy. Views poll while visible; the server pushes no flow events yet.
// Layer: Web data
// Exports: flowQueryKeys and the *QueryOptions factories

import type { FlowRunId, LedgerHandle, ProjectId } from "@saint/contracts";
import { LOCAL_HOST_ID, type HostId } from "@saint/shared/hostId";
import { queryOptions } from "@tanstack/react-query";

import { hostHandle } from "~/hosts/hostScope";
import { hostScopedQueryKey } from "~/hosts/viewedHost";
import { ensureLocalNativeApi } from "~/nativeApi";

// ponytail: polling; switch to a pushed flow stream if many flows run at once.
export const FLOW_POLL_INTERVAL_MS = 2_000;
export const STATUS_POLL_INTERVAL_MS = 10_000;

export const flowQueryKeys = {
  all: ["hyperagent"] as const,
  flows: ["hyperagent", "flows"] as const,
  flow: (flowId: FlowRunId) => ["hyperagent", "flows", flowId] as const,
  templates: ["hyperagent", "flow-templates"] as const,
  specs: (projectId: ProjectId | null) => ["hyperagent", "flow-specs", projectId] as const,
  sap: (flowId: FlowRunId) => ["hyperagent", "sap", flowId] as const,
  handle: (handle: LedgerHandle) => ["hyperagent", "handle", handle] as const,
  ledgerVerify: ["hyperagent", "ledger-verify"] as const,
  aegisStatus: ["hyperagent", "aegis-status"] as const,
  aegisAlerts: (includeResolved: boolean) =>
    ["hyperagent", "aegis-alerts", includeResolved] as const,
  economy: ["hyperagent", "economy"] as const,
  cyberSecurity: (hostId: HostId, projectId: ProjectId) =>
    ["hyperagent", "cyber-security", hostId, projectId] as const,
};

/** This computer's API, or a connected host's; throws while that host has no live connection. */
export const hostApi = (hostId: HostId) =>
  hostId === LOCAL_HOST_ID ? ensureLocalNativeApi() : hostHandle(hostId).requireApi();

const polled = { refetchIntervalInBackground: false, refetchOnWindowFocus: true } as const;

export const flowListQueryOptions = (hostId: HostId = LOCAL_HOST_ID) =>
  queryOptions({
    queryKey: hostScopedQueryKey(flowQueryKeys.flows, hostId),
    queryFn: () => hostApi(hostId).flows.list({}),
    refetchInterval: STATUS_POLL_INTERVAL_MS,
    ...polled,
  });

export const flowViewQueryOptions = (flowId: FlowRunId) =>
  queryOptions({
    queryKey: flowQueryKeys.flow(flowId),
    queryFn: () => ensureLocalNativeApi().flows.get({ flowId }),
    refetchInterval: FLOW_POLL_INTERVAL_MS,
    ...polled,
  });

export const flowTemplatesQueryOptions = () =>
  queryOptions({
    queryKey: flowQueryKeys.templates,
    queryFn: () => ensureLocalNativeApi().flows.templates({}),
    staleTime: Number.POSITIVE_INFINITY,
  });

export const flowSpecsQueryOptions = (projectId: ProjectId | null) =>
  queryOptions({
    queryKey: flowQueryKeys.specs(projectId),
    queryFn: () =>
      projectId
        ? ensureLocalNativeApi().flows.specs({ projectId })
        : Promise.resolve({ specs: [] }),
  });

export const sapListQueryOptions = (flowId: FlowRunId) =>
  queryOptions({
    queryKey: flowQueryKeys.sap(flowId),
    queryFn: () => ensureLocalNativeApi().sap.list({ flowId }),
    refetchInterval: FLOW_POLL_INTERVAL_MS,
    ...polled,
  });

export const ledgerHandleQueryOptions = (handle: LedgerHandle) =>
  queryOptions({
    queryKey: flowQueryKeys.handle(handle),
    queryFn: () => ensureLocalNativeApi().ledger.handle({ handle }),
    // Handles are content-addressed, so they never change.
    staleTime: Number.POSITIVE_INFINITY,
  });

export const ledgerVerifyQueryOptions = () =>
  queryOptions({
    queryKey: flowQueryKeys.ledgerVerify,
    queryFn: () => ensureLocalNativeApi().ledger.verify({}),
    refetchInterval: STATUS_POLL_INTERVAL_MS,
    ...polled,
  });

/** One project on one host: its skills, newest assessment and findings (the board's data). */
export const cyberSecurityStatusQueryOptions = (hostId: HostId, projectId: ProjectId) =>
  queryOptions({
    queryKey: flowQueryKeys.cyberSecurity(hostId, projectId),
    queryFn: () => hostHandle(hostId).requireApi().cyberSecurity.status({ projectId }),
    // Faster while the audit runs, so the verdict and findings appear as the flow finishes.
    refetchInterval: (query) =>
      query.state.data?.assessment?.verdict === "running"
        ? FLOW_POLL_INTERVAL_MS
        : STATUS_POLL_INTERVAL_MS,
    ...polled,
  });

export const aegisStatusQueryOptions = (hostId: HostId = LOCAL_HOST_ID) =>
  queryOptions({
    queryKey: hostScopedQueryKey(flowQueryKeys.aegisStatus, hostId),
    queryFn: () => hostApi(hostId).aegis.status({}),
    refetchInterval: STATUS_POLL_INTERVAL_MS,
    ...polled,
  });

export const aegisAlertsQueryOptions = (includeResolved: boolean) =>
  queryOptions({
    queryKey: flowQueryKeys.aegisAlerts(includeResolved),
    queryFn: () => ensureLocalNativeApi().aegis.alerts({ includeResolved }),
    refetchInterval: STATUS_POLL_INTERVAL_MS,
    ...polled,
  });

export const economyStatusQueryOptions = (hostId: HostId = LOCAL_HOST_ID) =>
  queryOptions({
    queryKey: hostScopedQueryKey(flowQueryKeys.economy, hostId),
    queryFn: () => hostApi(hostId).economy.status({}),
    refetchInterval: STATUS_POLL_INTERVAL_MS,
    ...polled,
  });
