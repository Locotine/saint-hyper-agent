// FILE: flowQueryOptions.ts
// Purpose: React Query keys and options for the HyperAgent RPCs: flows, the ledger, SAP, Aegis
//          and host economy. Views poll while visible; the server pushes no flow events yet.
// Layer: Web data
// Exports: flowQueryKeys and the *QueryOptions factories

import type { FlowRunId, LedgerHandle, ProjectId } from "@saint/contracts";
import { queryOptions } from "@tanstack/react-query";

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
};

const polled = { refetchIntervalInBackground: false, refetchOnWindowFocus: true } as const;

export const flowListQueryOptions = () =>
  queryOptions({
    queryKey: flowQueryKeys.flows,
    queryFn: () => ensureLocalNativeApi().flows.list({}),
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

export const aegisStatusQueryOptions = () =>
  queryOptions({
    queryKey: flowQueryKeys.aegisStatus,
    queryFn: () => ensureLocalNativeApi().aegis.status({}),
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

export const economyStatusQueryOptions = () =>
  queryOptions({
    queryKey: flowQueryKeys.economy,
    queryFn: () => ensureLocalNativeApi().economy.status({}),
    refetchInterval: STATUS_POLL_INTERVAL_MS,
    ...polled,
  });
