// FILE: FlowsIndexView.tsx
// Purpose: The Flows landing page: start a flow from a template, open a saved `flows/*.yaml` or a
//          blank Canvas, and list every run with its status.
// Layer: Web flow view
// Exports: FlowsIndexView, FlowTemplateStarter

import type { FlowRun, ProjectId } from "@saint/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { ProjectMenuPicker } from "~/components/ProjectMenuPicker";
import { RouteInsetSurface } from "~/components/RouteInsetSurface";
import { RouteSurface, RouteSurfaceHeader } from "~/components/RouteSurface";
import { Button } from "~/components/ui/button";
import { BUTTON_GROUP_ACTIVE_CLASS_NAME, ButtonGroup } from "~/components/ui/button-group";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { StatusChip } from "~/components/ui/status-chip";
import { formatRelativeTime } from "~/lib/relativeTime";
import {
  flowListQueryOptions,
  flowSpecsQueryOptions,
  flowTemplatesQueryOptions,
} from "~/lib/flowQueryOptions";
import { ChevronDownIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useStore } from "~/store";
import { useStartFlow } from "./useStartFlow";

const RUN_TONE: Record<FlowRun["status"], string> = {
  running: "text-info-foreground",
  paused: "text-warning",
  completed: "text-success",
  failed: "text-destructive",
  cancelled: "text-muted-foreground",
};

export function FlowsIndexView() {
  const navigate = useNavigate();
  const projects = useStore((state) => state.projects);
  const [projectId, setProjectId] = useState<ProjectId | null>(projects[0]?.id ?? null);
  const runs = useQuery(flowListQueryOptions());
  const specs = useQuery(flowSpecsQueryOptions(projectId));
  const projectName = (id: ProjectId) => projects.find((project) => project.id === id)?.name ?? "";
  const sortedRuns = (runs.data?.runs ?? []).toSorted((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );

  return (
    <RouteInsetSurface>
      <RouteSurface>
        <RouteSurfaceHeader>
          <ProjectMenuPicker
            projectOptions={projects.map((project) => ({ id: project.id, name: project.name }))}
            selectedProjectId={projectId}
            onProjectIdChange={setProjectId}
            trigger={
              <Button
                size="xs"
                variant="chrome-outline"
                disabled={projects.length === 0}
                aria-label="Choose the project for new flows"
                className="max-w-56 gap-1.5 font-medium"
              />
            }
          >
            <span className="min-w-0 truncate">
              {projectId ? projectName(projectId) : "No project"}
            </span>
            <ChevronDownIcon aria-hidden className="size-3 shrink-0 opacity-60" />
          </ProjectMenuPicker>
          <Button
            size="xs"
            className="ml-auto"
            disabled={!projectId}
            onClick={() =>
              void navigate({
                to: "/flows/$flowId",
                params: { flowId: "new" },
                search: { projectId: projectId ?? undefined },
              })
            }
          >
            New flow
          </Button>
        </RouteSurfaceHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[44rem] flex-col gap-7 px-6 pt-10 pb-20">
            <header className="flex flex-col gap-1">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">Flows</h1>
              <p className="text-ui text-muted-foreground">
                Steps run by agents in order, each checked by a gate before the next starts.
              </p>
            </header>

            {projectId ? (
              <FlowTemplateStarter
                projectId={projectId}
                onStarted={(flowId) => void navigate({ to: "/flows/$flowId", params: { flowId } })}
              />
            ) : null}

            {(specs.data?.specs.length ?? 0) > 0 ? (
              <section className="flex flex-col gap-1">
                <h2 className="text-ui-lg font-medium">Saved in this project</h2>
                {specs.data!.specs.map((spec) => (
                  <button
                    key={spec.path}
                    type="button"
                    className="rounded-md px-2 py-1.5 text-left font-mono text-ui-sm hover:bg-accent"
                    onClick={() =>
                      void navigate({
                        to: "/flows/$flowId",
                        params: { flowId: "new" },
                        search: { projectId: projectId ?? undefined, path: spec.path },
                      })
                    }
                  >
                    {spec.path}
                  </button>
                ))}
              </section>
            ) : null}

            <section className="flex flex-col gap-1">
              <h2 className="text-ui-lg font-medium">Runs</h2>
              {sortedRuns.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>No flows yet</EmptyTitle>
                    <EmptyDescription>
                      Start one from a template above or draw a new one.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div role="list" aria-label="Flow runs" className="flex flex-col gap-0.5">
                  {sortedRuns.map((run) => (
                    <button
                      key={run.id}
                      type="button"
                      role="listitem"
                      className="flex min-w-0 items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-accent"
                      onClick={() =>
                        void navigate({ to: "/flows/$flowId", params: { flowId: run.id } })
                      }
                    >
                      <StatusChip
                        pulse={run.status === "running"}
                        className={cn("w-24", RUN_TONE[run.status])}
                      >
                        {run.status}
                      </StatusChip>
                      <span className="min-w-0 flex-1 truncate text-ui">{run.spec.name}</span>
                      <span className="shrink-0 text-ui-sm text-muted-foreground">
                        {projectName(run.projectId)} · {formatRelativeTime(run.updatedAt)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      </RouteSurface>
    </RouteInsetSurface>
  );
}

/** Template picker + goal: the quickest way to run a flow (also the onboarding sample step). */
export function FlowTemplateStarter({
  projectId,
  onStarted,
}: {
  projectId: ProjectId;
  onStarted: (flowId: FlowRun["id"]) => void;
}) {
  const templates = useQuery(flowTemplatesQueryOptions());
  const startFlow = useStartFlow();
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [gateCmd, setGateCmd] = useState("");
  const list = templates.data?.templates ?? [];
  const selected = list.find((template) => template.id === templateId) ?? list[0];
  if (!selected) return null;
  return (
    <section aria-label="Start from a template" className="flex flex-col gap-2">
      <ButtonGroup label="Templates" className="flex-wrap [&_button]:!w-auto [&_button]:px-3">
        {list.map((template) => (
          <Button
            key={template.id}
            size="xs"
            variant="ghost"
            aria-pressed={template.id === selected.id}
            className={cn(template.id === selected.id && BUTTON_GROUP_ACTIVE_CLASS_NAME)}
            onClick={() => setTemplateId(template.id)}
          >
            {template.title}
          </Button>
        ))}
      </ButtonGroup>
      <p className="text-ui-sm text-muted-foreground">{selected.description}</p>
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          if (!goal.trim()) return;
          startFlow.mutate(
            {
              projectId,
              template: selected.id,
              goal: goal.trim(),
              ...(gateCmd.trim() ? { gateCmd: gateCmd.trim() } : {}),
            },
            { onSuccess: (view) => onStarted(view.run.id) },
          );
        }}
      >
        <Input
          aria-label="Goal"
          placeholder="What should the flow achieve?"
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          className="flex-1"
        />
        <Input
          aria-label="Gate command"
          placeholder="Gate, e.g. bun run typecheck"
          value={gateCmd}
          onChange={(event) => setGateCmd(event.target.value)}
          className="sm:w-56"
        />
        <Button type="submit" disabled={!goal.trim() || startFlow.isPending}>
          Run
        </Button>
      </form>
    </section>
  );
}
