import type { ProjectId } from "@saint/contracts";
import { scopeProject } from "@saint/shared/hostId";
import { useCallback, useEffect, useRef, useState } from "react";

import { useHostHandle } from "~/hosts/hostScope";
import { useProjectInstructionsStore } from "~/projectInstructionsStore";

export function useProjectInstructionsSource(projectId: ProjectId | null) {
  const chatHost = useHostHandle();
  const localInstructions = useProjectInstructionsStore((state) =>
    projectId
      ? (state.instructionsByProjectId[scopeProject(chatHost.hostId, projectId)] ?? "")
      : "",
  );
  const setLocalInstructions = useProjectInstructionsStore((state) => state.setInstructions);
  const [serverInstructions, setServerInstructions] = useState<string | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [serverBacked, setServerBacked] = useState(false);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  useEffect(() => {
    if (!projectId) {
      setServerInstructions(null);
      setServerBacked(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const api = chatHost.api();
      if (!api?.projectAgent) return;
      try {
        const overview = await api.projectAgent.getOverview({ projectId });
        if (cancelled || projectIdRef.current !== projectId) return;
        if (!overview.configured) {
          setServerBacked(false);
          setServerInstructions(null);
          return;
        }
        const read = await api.projectAgent.readDocument({
          projectId,
          logicalPath: "instructions.md",
        });
        if (cancelled || projectIdRef.current !== projectId) return;
        setServerBacked(true);
        setServerInstructions(read.document.content);
        setRevision(read.document.revision);
        setConflict(
          read.head.conflictPending
            ? "Project instructions changed on disk. Save again to import the external copy."
            : null,
        );
      } catch {
        if (cancelled || projectIdRef.current !== projectId) return;
        setServerBacked(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chatHost, projectId]);

  const onChange = useCallback(
    (nextProjectId: ProjectId, instructions: string) => {
      const api = chatHost.api();
      if (serverBacked && api?.projectAgent && revision !== null) {
        void api.projectAgent
          .writeDocument({
            requestId: crypto.randomUUID(),
            projectId: nextProjectId,
            logicalPath: "instructions.md",
            content: instructions,
            expectedRevision: revision,
          })
          .then((saved) => {
            if (projectIdRef.current !== nextProjectId) return;
            setServerInstructions(saved.content);
            setRevision(saved.revision);
            setConflict(null);
          })
          .catch((cause: unknown) => {
            if (projectIdRef.current !== nextProjectId) return;
            setConflict(
              cause instanceof Error ? cause.message : "Failed to save project instructions.",
            );
          });
        return;
      }
      setLocalInstructions(scopeProject(chatHost.hostId, nextProjectId), instructions);
    },
    [chatHost, revision, serverBacked, setLocalInstructions],
  );

  return {
    instructions: serverBacked ? (serverInstructions ?? localInstructions) : localInstructions,
    onChange,
    conflict,
    serverBacked,
  };
}
