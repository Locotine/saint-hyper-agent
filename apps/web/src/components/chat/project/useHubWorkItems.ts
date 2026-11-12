import type { HubWorkItem, ProjectId } from "@saint/contracts";
import { useEffect, useState } from "react";

import { apiFor, useHostId } from "~/hosts/hostScope";
import { mergeHubWorkItems } from "./hubWorkItems";

const EMPTY_WORK_ITEMS: readonly HubWorkItem[] = [];

export function useHubWorkItems(projectId: ProjectId | null) {
  const hostId = useHostId();
  const [state, setState] = useState<{
    projectId: ProjectId | null;
    items: readonly HubWorkItem[];
  }>({ projectId: null, items: EMPTY_WORK_ITEMS });

  useEffect(() => {
    const api = apiFor(hostId);
    if (!projectId || !api?.projectAgent) return;
    let disposed = false;
    const apply = (items: readonly HubWorkItem[]) => {
      if (disposed) return;
      setState((current) => ({
        projectId,
        items: mergeHubWorkItems(current.projectId === projectId ? current.items : [], items),
      }));
    };
    const unsubscribeEvents = api.projectAgent.onEvent((event) => {
      if (event.type === "snapshot" && event.overview.projectId === projectId) {
        apply(event.overview.hubWorkItems ?? EMPTY_WORK_ITEMS);
      } else if (event.type === "work-item-upserted" && event.projectId === projectId) {
        apply([event.workItem]);
      }
    });
    void api.projectAgent.subscribe({ projectId }).catch(() => undefined);
    void api.projectAgent
      .getOverview({ projectId })
      .then((overview) => {
        apply(overview.hubWorkItems ?? EMPTY_WORK_ITEMS);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribeEvents();
      void api.projectAgent.unsubscribe({ projectId }).catch(() => undefined);
    };
  }, [hostId, projectId]);

  return state.projectId === projectId ? state.items : EMPTY_WORK_ITEMS;
}
