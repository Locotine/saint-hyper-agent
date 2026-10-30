// FILE: FlowMissionControl.tsx
// Purpose: Mission Control (S5): for the flow's live edge, the upstream step's transcript on the
//          left and the receiving step's on the right, with the handoff between them; the flow's
//          SAP messages underneath with the share Saint answered at 0 tokens.
// Layer: Web flow view
// Exports: FlowMissionControl

import type { FlowNodeRun, FlowRunView, SapMessage, ThreadId } from "@saint/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { Badge } from "~/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { StatusChip } from "~/components/ui/status-chip";
import { sapListQueryOptions } from "~/lib/flowQueryOptions";
import { cn } from "~/lib/utils";
import { useStore } from "~/store";
import { createThreadSelector } from "~/storeSelectors";
import { retainThreadDetailSubscription } from "~/threadDetailSubscriptionRetention";
import { FLOW_NODE_STATUS_LABEL, flowNodeStatusClassName } from "./FlowCanvas";
import { flowEdgeState } from "./flowCanvas.logic";

const TRANSCRIPT_TAIL = 6;

/** The live edge, else the edge into the step running now, else the last settled edge. */
function pickMissionEdge(view: FlowRunView) {
  const runs = new Map(view.nodes.map((node) => [node.nodeId, node]));
  const approved = new Set(view.approvedEdges);
  const edges = view.run.spec.edges;
  const live = edges.find((edge) => flowEdgeState(edge, runs, approved) === "live");
  if (live) return live;
  const running = view.nodes.find((node) => node.status === "running" || node.status === "gating");
  if (running) return edges.find((edge) => edge.to === running.nodeId) ?? null;
  return edges.findLast((edge) => flowEdgeState(edge, runs, approved) === "done") ?? null;
}

export function FlowMissionControl({ view }: { view: FlowRunView }) {
  const edge = pickMissionEdge(view);
  const runs = new Map(view.nodes.map((node) => [node.nodeId, node]));
  const sap = useQuery(sapListQueryOptions(view.run.id));
  const from = edge ? runs.get(edge.from) : undefined;
  const to = edge ? runs.get(edge.to) : undefined;
  const handoff = from?.handoff ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4">
      {edge ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-2">
          <TranscriptPane node={from} label="Thinking" />
          <TranscriptPane node={to} label="Receiving" />
        </div>
      ) : (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>No step is handing off yet</EmptyTitle>
            <EmptyDescription>
              Mission Control follows the edge that is live right now.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {handoff ? (
        <p className="flex min-w-0 items-center gap-2 text-ui-sm text-muted-foreground">
          <Badge variant="info">HANDOFF</Badge>
          <span className="truncate">
            {handoff.target} — {handoff.ownership.join(", ")}
          </span>
          {handoff.refs.map((ref) => (
            <Badge key={ref} variant="outline" className="font-mono">
              {ref}
            </Badge>
          ))}
        </p>
      ) : null}
      <SapFeed
        messages={sap.data?.messages ?? []}
        asks={sap.data?.stats.asks ?? 0}
        answeredBySaint={sap.data?.stats.answeredBySaint ?? 0}
      />
    </div>
  );
}

function TranscriptPane({ node, label }: { node: FlowNodeRun | undefined; label: string }) {
  const threadId = node?.threadId ?? null;
  useEffect(() => (threadId ? retainThreadDetailSubscription(threadId) : undefined), [threadId]);
  const thread = useStore(
    useMemo(() => createThreadSelector(threadId as ThreadId | null), [threadId]),
  );
  const tail = (thread?.messages ?? [])
    .filter((message) => message.role !== "system")
    .slice(-TRANSCRIPT_TAIL);
  return (
    <section
      aria-label={`${label}: ${node?.nodeId ?? "none"}`}
      className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border"
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-ui-sm text-muted-foreground">{label}</span>
        <span className="min-w-0 flex-1 truncate text-ui font-medium">{node?.nodeId ?? "—"}</span>
        {node ? (
          <StatusChip
            pulse={node.status === "running" || node.status === "gating"}
            className={cn("text-ui-xs", flowNodeStatusClassName(node.status))}
          >
            {FLOW_NODE_STATUS_LABEL[node.status]}
          </StatusChip>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2">
        {tail.length === 0 ? (
          <p className="text-ui-sm text-muted-foreground">
            {threadId ? "Waiting for the first reply…" : "Not started."}
          </p>
        ) : (
          tail.map((message) => (
            <div key={message.id} className="text-chat-sm">
              <p className="text-ui-xs text-muted-foreground">
                {message.role === "user" ? "Prompt" : "Agent"}
              </p>
              <ChatMarkdown text={message.text} cwd={undefined} isStreaming={message.streaming} />
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function SapFeed({
  messages,
  asks,
  answeredBySaint,
}: {
  messages: ReadonlyArray<SapMessage>;
  asks: number;
  answeredBySaint: number;
}) {
  const deterministicPct = asks === 0 ? null : Math.round((answeredBySaint / asks) * 100);
  return (
    <section
      aria-label="SAP bus"
      className="flex max-h-56 min-h-0 flex-col rounded-lg border border-border"
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="flex-1 text-ui font-medium">SAP bus</span>
        <span className="text-ui-sm text-muted-foreground">
          {deterministicPct === null
            ? "No questions yet"
            : `${deterministicPct}% of questions answered by Saint · 0 tokens`}
        </span>
      </header>
      <ol className="min-h-0 flex-1 overflow-y-auto px-3 py-1">
        {messages.map((message) => (
          <li key={message.id} className="flex min-w-0 items-center gap-2 py-1 text-ui-sm">
            <Badge variant={message.act === "ESCALATE" ? "warning" : "secondary"} size="sm">
              {message.act}
            </Badge>
            <span className="shrink-0 text-muted-foreground">
              {message.from} → {message.to}
            </span>
            <span className="min-w-0 flex-1 truncate">{message.answer ?? message.body}</span>
            {message.answeredBy === "saint" ? (
              <Badge variant="success" size="sm">
                0 tok
              </Badge>
            ) : null}
            {message.verified === false ? (
              <Badge variant="warning" size="sm">
                unverified
              </Badge>
            ) : null}
            {message.state === "dropped" ? (
              <Badge variant="error" size="sm">
                dropped
              </Badge>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
