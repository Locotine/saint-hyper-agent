// FILE: FlowAttention.tsx
// Purpose: The flow side of "needs you": a hook that gathers held steps and hand-offs across
//          running flows, and the strip the Kanban board shows above its columns with
//          Approve, Open and a riskiest-first Approve all.
// Layer: Web flow view
// Exports: useFlowAttention, FlowAttentionStrip

import type { ProjectId } from "@saint/contracts";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { flowListQueryOptions, flowQueryKeys, flowViewQueryOptions } from "~/lib/flowQueryOptions";
import { ensureLocalNativeApi } from "~/nativeApi";
import { collectFlowAttention, type FlowAttentionItem } from "./flowAttention.logic";

export function useFlowAttention(projectId?: ProjectId): FlowAttentionItem[] {
  const list = useQuery(flowListQueryOptions());
  const active = (list.data?.runs ?? []).filter(
    (run) =>
      (run.status === "running" || run.status === "paused") &&
      (projectId === undefined || run.projectId === projectId),
  );
  const views = useQueries({ queries: active.map((run) => flowViewQueryOptions(run.id)) });
  return collectFlowAttention(
    views.flatMap((query) => (query.data?.view ? [query.data.view] : [])),
  );
}

export function FlowAttentionStrip({ projectId }: { projectId: ProjectId }) {
  const items = useFlowAttention(projectId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const approve = useMutation({
    // One at a time, riskiest first, so a failure stops the batch where it happened.
    mutationFn: async (batch: ReadonlyArray<FlowAttentionItem>) => {
      for (const item of batch) {
        await ensureLocalNativeApi().flows.action({ flowId: item.flowId, ...item.approve });
      }
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: flowQueryKeys.flows }),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Couldn't approve",
        description: error instanceof Error ? error.message : String(error),
      }),
  });
  if (items.length === 0) return null;
  return (
    <section aria-label="Flows waiting for you" className="flex flex-col gap-1 px-4 pb-3">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-ui font-medium">Flows waiting for you</span>
        {items.length > 1 ? (
          <Button
            size="xs"
            variant="outline"
            disabled={approve.isPending}
            onClick={() => approve.mutate(items)}
          >
            Approve all ({items.length})
          </Button>
        ) : null}
      </div>
      {items.map((item) => (
        <div
          key={item.key}
          className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 hover:bg-accent"
        >
          <Badge variant={item.risk === 0 ? "error" : item.risk === 1 ? "warning" : "secondary"}>
            {item.flowName}
          </Badge>
          <span className="shrink-0 text-ui">{item.title}</span>
          <span className="min-w-0 flex-1 truncate text-ui-sm text-muted-foreground">
            {item.detail}
          </span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void navigate({ to: "/flows/$flowId", params: { flowId: item.flowId } })}
          >
            View evidence
          </Button>
          <Button size="xs" disabled={approve.isPending} onClick={() => approve.mutate([item])}>
            Approve
          </Button>
        </div>
      ))}
    </section>
  );
}
