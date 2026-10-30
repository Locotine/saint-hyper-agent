// FILE: useStartFlow.ts
// Purpose: Starts a flow from YAML or a template with the project's default model (else Codex's
//          default), at the "auto" runtime mode Aegis caps further by the autonomy level.
// Layer: Web flow hook
// Exports: useStartFlow

import type { FlowStartRpcInput, ModelSelection, ProjectId } from "@saint/contracts";
import { getDefaultModel } from "@saint/shared/model";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { toastManager } from "~/components/ui/toast";
import { flowQueryKeys } from "~/lib/flowQueryOptions";
import { ensureLocalNativeApi } from "~/nativeApi";
import { useStore } from "~/store";

export type StartFlowInput = Omit<FlowStartRpcInput, "modelSelection" | "runtimeMode"> & {
  readonly projectId: ProjectId;
};

export function useStartFlow() {
  const queryClient = useQueryClient();
  const projects = useStore((state) => state.projects);
  return useMutation({
    mutationFn: (input: StartFlowInput) => {
      const project = projects.find((candidate) => candidate.id === input.projectId);
      const modelSelection: ModelSelection = project?.defaultModelSelection ?? {
        provider: "codex",
        model: getDefaultModel("codex"),
      };
      return ensureLocalNativeApi().flows.start({ ...input, modelSelection, runtimeMode: "auto" });
    },
    onSuccess: (view) => {
      queryClient.setQueryData(flowQueryKeys.flow(view.run.id), { view });
      void queryClient.invalidateQueries({ queryKey: flowQueryKeys.flows });
    },
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Couldn't start the flow",
        description: error instanceof Error ? error.message : String(error),
      }),
  });
}
