// FILE: FlowView.tsx
// Purpose: One flow (S4 Canvas + S5 Mission Control). A run shows live state with an inspector
//          that drives each step; "Edit as new flow" (or /flows/new) turns the Canvas into an
//          editor kept in two-way sync with the flow-v1 YAML, saved through flow.saveSpec.
// Layer: Web flow view
// Exports: FlowView

import type {
  FlowActionInput,
  FlowNodeMode,
  FlowRunView,
  FlowSpec,
  LedgerHandle,
  ProjectId,
} from "@saint/contracts";
import { parseFlowSpecYaml, stringifyFlowSpecYaml } from "@saint/shared/flowSpec";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { RouteInsetSurface } from "~/components/RouteInsetSurface";
import { RouteSurface, RouteSurfaceHeader } from "~/components/RouteSurface";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { BUTTON_GROUP_ACTIVE_CLASS_NAME, ButtonGroup } from "~/components/ui/button-group";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { StatusChip } from "~/components/ui/status-chip";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import {
  flowQueryKeys,
  flowSpecsQueryOptions,
  flowViewQueryOptions,
  ledgerHandleQueryOptions,
} from "~/lib/flowQueryOptions";
import { cn } from "~/lib/utils";
import { ensureLocalNativeApi } from "~/nativeApi";
import {
  FLOW_NODE_STATUS_LABEL,
  FlowCanvas,
  flowNodeStatusClassName,
  type FlowCanvasSelection,
} from "./FlowCanvas";
import {
  addFlowNode,
  blankFlowSpec,
  connectFlowNodes,
  edgeKey,
  removeFlowEdge,
  removeFlowNode,
  updateFlowEdge,
  updateFlowNode,
} from "./flowCanvas.logic";
import { FlowMissionControl } from "./FlowMissionControl";
import { useStartFlow } from "./useStartFlow";

interface Draft {
  readonly spec: FlowSpec;
  readonly yaml: string;
  readonly errors: ReadonlyArray<string>;
}

const draftFrom = (spec: FlowSpec): Draft => ({
  spec,
  yaml: stringifyFlowSpecYaml(spec),
  errors: [],
});

const NODE_MODES: ReadonlyArray<{ id: FlowNodeMode; label: string }> = [
  { id: "manual", label: "Manual" },
  { id: "gate_hold", label: "Hold" },
  { id: "auto_refix", label: "Refix" },
  { id: "autopilot", label: "Autopilot" },
];

function toastError(title: string) {
  return (error: unknown) =>
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    });
}

/** `flowId` is a run id, or "new" for a blank (or saved, by `specPath`) draft. */
export function FlowView({
  flowId,
  projectId,
  specPath,
}: {
  flowId: string;
  projectId: ProjectId | null;
  specPath: string | null;
}) {
  const isNew = flowId === "new";
  const query = useQuery({
    ...flowViewQueryOptions(flowId as FlowRunView["run"]["id"]),
    enabled: !isNew,
  });
  const saved = useQuery({
    ...flowSpecsQueryOptions(projectId),
    enabled: isNew && specPath !== null,
  });
  const view = query.data?.view ?? null;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tab, setTab] = useState<"canvas" | "mission">("canvas");
  const [selection, setSelection] = useState<FlowCanvasSelection>(null);

  // A blank draft (or the saved file it names) once its source is known.
  if (isNew && draft === null) {
    const savedYaml = specPath
      ? saved.data?.specs.find((spec) => spec.path === specPath)?.yaml
      : undefined;
    const parsed = savedYaml ? parseFlowSpecYaml(savedYaml) : null;
    if (!specPath || saved.isFetched) {
      setDraft(
        parsed?._tag === "ok"
          ? { spec: parsed.spec, yaml: savedYaml!, errors: [] }
          : draftFrom(blankFlowSpec()),
      );
    }
  }

  const editing = draft !== null;
  const spec = draft?.spec ?? view?.run.spec ?? null;
  const flowProjectId = view?.run.projectId ?? projectId;

  if (!spec) {
    return (
      <RouteInsetSurface>
        <RouteSurface>
          <RouteSurfaceHeader />
          <div className="flex flex-1 items-center justify-center text-ui text-muted-foreground">
            {query.isError ? (
              "Couldn't load this flow."
            ) : query.isFetched && !isNew ? (
              "Flow not found."
            ) : (
              <Spinner />
            )}
          </div>
        </RouteSurface>
      </RouteInsetSurface>
    );
  }

  const setSpec = (next: FlowSpec | null) => {
    if (next) setDraft(draftFrom(next));
  };
  const nodeRuns = new Map(editing ? [] : (view?.nodes ?? []).map((node) => [node.nodeId, node]));

  return (
    <RouteInsetSurface>
      <RouteSurface>
        <RouteSurfaceHeader>
          <h1 className="min-w-0 truncate text-ui-lg font-medium">{spec.name}</h1>
          {view && !editing ? <RunStatus view={view} /> : null}
          <div className="ml-auto flex items-center gap-2">
            {view && !editing ? (
              <ButtonGroup label="Flow view" className="[&_button]:!w-auto [&_button]:px-3">
                {(["canvas", "mission"] as const).map((id) => (
                  <Button
                    key={id}
                    size="xs"
                    variant="ghost"
                    aria-pressed={tab === id}
                    className={cn(tab === id && BUTTON_GROUP_ACTIVE_CLASS_NAME)}
                    onClick={() => setTab(id)}
                  >
                    {id === "canvas" ? "Canvas" : "Mission Control"}
                  </Button>
                ))}
              </ButtonGroup>
            ) : null}
            {view && !editing ? (
              <>
                <RunControls view={view} />
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => setDraft(draftFrom(view.run.spec))}
                >
                  Edit as new flow
                </Button>
              </>
            ) : null}
            {editing && flowProjectId ? (
              <DraftControls draft={draft} projectId={flowProjectId} />
            ) : null}
          </div>
        </RouteSurfaceHeader>

        {tab === "mission" && view && !editing ? (
          <FlowMissionControl view={view} />
        ) : (
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              {editing ? (
                <div className="flex items-center gap-2 border-b border-border px-4 py-2">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      const added = addFlowNode(spec);
                      setSpec(added.spec);
                      setSelection({ kind: "node", id: added.nodeId });
                    }}
                  >
                    + Step
                  </Button>
                  <span className="text-ui-sm text-muted-foreground">
                    Drag a step to move it; drag its right dot onto another step to connect.
                  </span>
                </div>
              ) : null}
              <FlowCanvas
                spec={spec}
                nodeRuns={nodeRuns}
                approvedEdges={new Set(view?.approvedEdges ?? [])}
                editable={editing}
                selection={selection}
                onSelect={setSelection}
                onConnect={(from, to) => {
                  const next = connectFlowNodes(spec, from, to);
                  if (next) setSpec(next);
                  else
                    toastManager.add({
                      type: "warning",
                      title: "That edge would repeat or close a loop.",
                    });
                }}
              />
              {editing ? (
                <YamlPane
                  draft={draft}
                  onChange={(yaml) => {
                    const parsed = parseFlowSpecYaml(yaml);
                    setDraft(
                      parsed._tag === "ok"
                        ? { spec: parsed.spec, yaml, errors: [] }
                        : { spec: draft.spec, yaml, errors: parsed.errors },
                    );
                  }}
                />
              ) : null}
            </div>
            <aside
              aria-label="Inspector"
              className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border p-4"
            >
              {editing ? (
                <DraftInspector
                  spec={spec}
                  selection={selection}
                  onChange={setSpec}
                  onSelect={setSelection}
                />
              ) : view ? (
                <RunInspector view={view} selection={selection} />
              ) : null}
            </aside>
          </div>
        )}
      </RouteSurface>
    </RouteInsetSurface>
  );
}

function RunStatus({ view }: { view: FlowRunView }) {
  const { status, statusReason } = view.run;
  const tone =
    status === "running"
      ? "text-info-foreground"
      : status === "completed"
        ? "text-success"
        : status === "failed"
          ? "text-destructive"
          : "text-muted-foreground";
  return (
    <StatusChip variant="pill" pulse={status === "running"} className={tone}>
      <span title={statusReason ?? undefined}>{status}</span>
    </StatusChip>
  );
}

function useFlowAction(flowId: FlowRunView["run"]["id"]) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<FlowActionInput, "flowId">) =>
      ensureLocalNativeApi().flows.action({ flowId, ...input }),
    onSuccess: (result) => queryClient.setQueryData(flowQueryKeys.flow(flowId), result),
    onError: toastError("Couldn't update the flow"),
  });
}

function RunControls({ view }: { view: FlowRunView }) {
  const action = useFlowAction(view.run.id);
  const { status } = view.run;
  if (status !== "running" && status !== "paused") return null;
  return (
    <>
      <Button
        size="xs"
        variant="outline"
        disabled={action.isPending}
        onClick={() => action.mutate({ action: status === "running" ? "pause" : "resume" })}
      >
        {status === "running" ? "Pause" : "Resume"}
      </Button>
      <Button
        size="xs"
        variant="destructive-outline"
        disabled={action.isPending}
        onClick={() => action.mutate({ action: "cancel" })}
      >
        Cancel
      </Button>
    </>
  );
}

function DraftControls({ draft, projectId }: { draft: Draft; projectId: ProjectId }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const startFlow = useStartFlow();
  const save = useMutation({
    mutationFn: () => ensureLocalNativeApi().flows.saveSpec({ projectId, yaml: draft.yaml }),
    onSuccess: ({ path }) => {
      void queryClient.invalidateQueries({ queryKey: flowQueryKeys.specs(projectId) });
      toastManager.add({ type: "success", title: `Saved ${path}` });
    },
    onError: toastError("Couldn't save the flow"),
  });
  const invalid = draft.errors.length > 0;
  return (
    <>
      <Button
        size="xs"
        variant="outline"
        disabled={invalid || save.isPending}
        onClick={() => save.mutate()}
      >
        Save
      </Button>
      <Button
        size="xs"
        disabled={invalid || startFlow.isPending}
        onClick={() =>
          startFlow.mutate(
            { projectId, spec: draft.yaml },
            {
              onSuccess: (view) =>
                void navigate({ to: "/flows/$flowId", params: { flowId: view.run.id } }),
            },
          )
        }
      >
        Run
      </Button>
    </>
  );
}

function YamlPane({ draft, onChange }: { draft: Draft; onChange: (yaml: string) => void }) {
  return (
    <div className="flex max-h-[40%] min-h-32 flex-col border-t border-border">
      <div className="flex items-center gap-2 px-4 py-1.5">
        <span className="text-ui-sm font-medium">YAML</span>
        {draft.errors.length > 0 ? (
          <span
            role="alert"
            className="min-w-0 truncate text-ui-sm text-destructive"
            title={draft.errors.join("\n")}
          >
            {draft.errors[0]}
          </span>
        ) : (
          <span className="text-ui-sm text-muted-foreground">In sync with the Canvas</span>
        )}
      </div>
      <Textarea
        aria-label="Flow YAML"
        value={draft.yaml}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-0 flex-1 overflow-auto rounded-none border-0 font-mono text-ui-sm"
      />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-ui-sm text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function DraftInspector({
  spec,
  selection,
  onChange,
  onSelect,
}: {
  spec: FlowSpec;
  selection: FlowCanvasSelection;
  onChange: (spec: FlowSpec | null) => void;
  onSelect: (selection: FlowCanvasSelection) => void;
}) {
  if (selection?.kind === "edge") {
    const edge = spec.edges.find((candidate) => edgeKey(candidate) === selection.id);
    if (!edge) return null;
    return (
      <>
        <p className="text-ui font-medium">
          {edge.from} → {edge.to}
        </p>
        <Field label="Hand-off">
          <ButtonGroup label="Edge policy" className="[&_button]:!w-auto [&_button]:px-3">
            {(["auto", "hold"] as const).map((policy) => (
              <Button
                key={policy}
                size="xs"
                variant="ghost"
                aria-pressed={(edge.policy ?? "auto") === policy}
                className={cn((edge.policy ?? "auto") === policy && BUTTON_GROUP_ACTIVE_CLASS_NAME)}
                onClick={() => onChange(updateFlowEdge(spec, selection.id, { policy }))}
              >
                {policy === "auto" ? "Automatic" : "Wait for approval"}
              </Button>
            ))}
          </ButtonGroup>
        </Field>
        <Button
          size="xs"
          variant="destructive-outline"
          onClick={() => {
            onChange(removeFlowEdge(spec, selection.id));
            onSelect(null);
          }}
        >
          Remove edge
        </Button>
      </>
    );
  }
  const node =
    selection?.kind === "node"
      ? spec.nodes.find((candidate) => candidate.id === selection.id)
      : undefined;
  if (!node) {
    return (
      <>
        <Field label="Flow name">
          <Input
            size="sm"
            value={spec.name}
            onChange={(event) =>
              event.target.value.trim() && onChange({ ...spec, name: event.target.value })
            }
          />
        </Field>
        <p className="text-ui-sm text-muted-foreground">Select a step or an edge to edit it.</p>
      </>
    );
  }
  const patch = (value: Parameters<typeof updateFlowNode>[2]) =>
    onChange(updateFlowNode(spec, node.id, value));
  return (
    <>
      <Field label="Step id">
        <Input
          size="sm"
          defaultValue={node.id}
          key={node.id}
          onBlur={(event) => {
            const id = event.target.value.trim();
            const next = updateFlowNode(spec, node.id, { id });
            if (next) {
              onChange(next);
              onSelect({ kind: "node", id });
            } else event.target.value = node.id;
          }}
        />
      </Field>
      <Field label="Role">
        <Input
          size="sm"
          value={node.role}
          onChange={(event) => event.target.value.trim() && patch({ role: event.target.value })}
        />
      </Field>
      <Field label="Prompt">
        <Textarea
          size="sm"
          value={node.prompt}
          onChange={(event) => event.target.value.trim() && patch({ prompt: event.target.value })}
        />
      </Field>
      <Field label="Mode">
        <ButtonGroup label="Step mode" className="flex-wrap [&_button]:!w-auto [&_button]:px-2">
          {NODE_MODES.map((mode) => (
            <Button
              key={mode.id}
              size="xs"
              variant="ghost"
              aria-pressed={(node.mode ?? "auto_refix") === mode.id}
              className={cn(
                (node.mode ?? "auto_refix") === mode.id && BUTTON_GROUP_ACTIVE_CLASS_NAME,
              )}
              onClick={() => patch({ mode: mode.id })}
            >
              {mode.label}
            </Button>
          ))}
        </ButtonGroup>
      </Field>
      <Field label="Gate command">
        <Input
          size="sm"
          placeholder="bun run typecheck"
          defaultValue={node.gate?.cmd ?? ""}
          key={`${node.id}-gate`}
          onBlur={(event) => {
            const cmd = event.target.value.trim();
            if (cmd) {
              patch({ gate: { ...node.gate, id: node.gate?.id ?? "check", cmd } });
              return;
            }
            const { gate: _gate, ...withoutGate } = node;
            onChange({
              ...spec,
              nodes: spec.nodes.map((candidate) =>
                candidate.id === node.id ? withoutGate : candidate,
              ),
            });
          }}
        />
      </Field>
      <Button
        size="xs"
        variant="destructive-outline"
        disabled={spec.nodes.length <= 1}
        onClick={() => {
          onChange(removeFlowNode(spec, node.id));
          onSelect(null);
        }}
      >
        Remove step
      </Button>
    </>
  );
}

function RunInspector({ view, selection }: { view: FlowRunView; selection: FlowCanvasSelection }) {
  const action = useFlowAction(view.run.id);
  const navigate = useNavigate();
  const [evidenceOpen, setEvidenceOpen] = useState(false);

  if (selection?.kind === "edge") {
    const edge = view.run.spec.edges.find((candidate) => edgeKey(candidate) === selection.id);
    if (!edge) return null;
    const waiting = edge.policy === "hold" && !view.approvedEdges.includes(selection.id);
    return (
      <>
        <p className="text-ui font-medium">
          {edge.from} → {edge.to}
        </p>
        <p className="text-ui-sm text-muted-foreground">
          {edge.policy === "hold"
            ? waiting
              ? "Waits for your approval."
              : "Approved."
            : "Hands off automatically."}
        </p>
        {waiting ? (
          <Button
            size="xs"
            disabled={action.isPending}
            onClick={() => action.mutate({ action: "approveEdge", from: edge.from, to: edge.to })}
          >
            Approve hand-off
          </Button>
        ) : null}
      </>
    );
  }
  const node =
    selection?.kind === "node"
      ? view.nodes.find((candidate) => candidate.nodeId === selection.id)
      : undefined;
  const nodeSpec = node
    ? view.run.spec.nodes.find((candidate) => candidate.id === node.nodeId)
    : undefined;
  if (!node || !nodeSpec) {
    return (
      <p className="text-ui-sm text-muted-foreground">
        {view.run.statusReason ?? "Select a step to see its details and controls."}
      </p>
    );
  }
  const nodeAction = (kind: FlowActionInput["action"]) => () =>
    action.mutate({ action: kind, nodeId: node.nodeId });
  const gate = node.lastGate ?? null;
  return (
    <>
      <div className="flex flex-col gap-1">
        <p className="text-ui-lg font-medium">{nodeSpec.role}</p>
        <StatusChip
          pulse={node.status === "running" || node.status === "gating"}
          className={flowNodeStatusClassName(node.status)}
        >
          {node.nodeId} · {FLOW_NODE_STATUS_LABEL[node.status]} · attempt {node.attempts}
        </StatusChip>
        {node.statusReason ? (
          <p className="text-ui-sm text-muted-foreground">{node.statusReason}</p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {node.threadId ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              void navigate({ to: "/$threadId", params: { threadId: node.threadId! } })
            }
          >
            Open chat
          </Button>
        ) : null}
        {node.status === "needs_you" ? (
          <Button size="xs" disabled={action.isPending} onClick={nodeAction("approveNode")}>
            Approve
          </Button>
        ) : null}
        {node.status === "failed" || node.status === "needs_you" ? (
          <Button
            size="xs"
            variant="outline"
            disabled={action.isPending}
            onClick={nodeAction("retryNode")}
          >
            Retry
          </Button>
        ) : null}
        {nodeSpec.gate && node.threadId ? (
          <Button
            size="xs"
            variant="outline"
            disabled={action.isPending}
            onClick={nodeAction("rerunGate")}
          >
            Re-run gate
          </Button>
        ) : null}
        {node.threadId && node.status !== "settled" ? (
          <Button
            size="xs"
            variant="outline"
            disabled={action.isPending}
            onClick={nodeAction("continueNode")}
          >
            Fork & continue
          </Button>
        ) : null}
      </div>
      {gate ? (
        <div className="flex flex-col gap-1.5">
          <p className="flex items-center gap-2 text-ui-sm">
            <Badge variant={gate.passed ? "success" : "error"}>
              {gate.passed ? "Gate passed" : "Gate failed"}
            </Badge>
            <span className="text-muted-foreground">
              exit {gate.exitCode ?? "—"} · {Math.round(gate.durationMs / 100) / 10}s
            </span>
          </p>
          {gate.protectedEdits.length > 0 ? (
            <p className="text-ui-sm text-warning">
              Edited protected files: {gate.protectedEdits.join(", ")}
            </p>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            className="self-start"
            onClick={() => setEvidenceOpen((open) => !open)}
          >
            {evidenceOpen ? "Hide log" : "Open log"}{" "}
            <span className="font-mono">{gate.evidence}</span>
          </Button>
          <DisclosureRegion open={evidenceOpen}>
            {evidenceOpen ? <HandleContent handle={gate.evidence} /> : null}
          </DisclosureRegion>
        </div>
      ) : null}
      {node.handoff ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ui-sm">
          {(
            [
              ["Target", node.handoff.target],
              ["Change", node.handoff.change],
              ["Constraints", node.handoff.constraints],
              ["Files", node.handoff.ownership.join(", ")],
              ["Acceptance", node.handoff.acceptance],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 break-words">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </>
  );
}

function HandleContent({ handle }: { handle: LedgerHandle }) {
  const query = useQuery(ledgerHandleQueryOptions(handle));
  if (query.isPending) return <Spinner />;
  return (
    <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-ui-xs whitespace-pre-wrap">
      {query.data?.handle?.content ?? "The log is gone."}
    </pre>
  );
}
