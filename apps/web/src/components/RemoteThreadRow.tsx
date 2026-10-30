// FILE: RemoteThreadRow.tsx
// Purpose: A remote host's thread in the sidebar. It is drawn with the same row pieces as this
//          computer's threads (title, status glyph, hover pin/archive/delete, nested subagent
//          sessions) and opens the same right-click menu, acting on the host instead.
// Layer: Sidebar UI
// Exports: RemoteThreadRow, HostLabel, useRemotePinnedThreads

import type { ProjectAgentSummary, ProjectId, ThreadId } from "@saint/contracts";
import { resolveThreadWorkspaceCwd } from "@saint/shared/threadEnvironment";
import { LOCAL_HOST_ID, scopeThread, unscopeThread, type HostId } from "@saint/shared/hostId";
import { useNavigate } from "@tanstack/react-router";
import { useState, useSyncExternalStore } from "react";

import { getProviderInstanceOptions, useAppSettings } from "~/appSettings";
import { toastManager } from "~/components/ui/toast";
import { useCopyPathToClipboard, useCopyThreadIdToClipboard } from "~/hooks/useCopyToClipboard";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { useThreadHandoff } from "~/hooks/useThreadHandoff";
import { apiFor, hostHandle, HostScope } from "~/hosts/hostScope";
import { followHostThread } from "~/hosts/hostThreadDetail";
import { hostStores } from "~/hosts/hostStores";
import { deleteHostThread, updateHostThreadMeta } from "~/hosts/hostThreadCreate";
import { archiveThreadFromClient } from "~/lib/threadArchive";
import { ServerIcon } from "~/lib/icons";
import { openPathInThreadTerminal } from "~/lib/openPathInThreadTerminal";
import { threadState, type RemoteCatalogThread } from "~/lib/remoteHostCatalog";
import { resolveSubagentThreadStatusKind } from "~/lib/subagentPresentation";
import {
  canContinueThreadHandoff,
  canCreateThreadHandoff,
  resolveAvailableHandoffTargets,
  resolveThreadHandoffAvailability,
} from "~/lib/threadHandoff";
import { canForkThread, dispatchThreadFork } from "~/lib/threadFork";
import { buildThreadContextMenuItems } from "~/lib/threadContextMenuItems";
import {
  SNOOZE_PRESETS,
  dispatchThreadSnoozedUntil,
  formatSnoozeDeadline,
  resolveSnoozeDeadline,
} from "~/lib/threadSnooze";
import { cn } from "~/lib/utils";
import { usePinnedThreadsStore } from "~/pinnedThreadsStore";
import { getThreadFromState } from "~/threadDerivation";
import { showReactContextMenu } from "./ReactContextMenu";
import { RenameThreadDialog } from "./RenameThreadDialog";
import { SnoozeUntilDialog } from "./SnoozeUntilDialog";
import {
  canSnoozeSidebarThread,
  resolveThreadRowAriaLabel,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
} from "./Sidebar.logic";
import {
  NestedThreadsToggle,
  SidebarNestedThreads,
  useNestedThreadsOpen,
} from "./SidebarNestedThreads";
import { SidebarRowHoverActions } from "./SidebarRowHoverActions";
import { SidebarThreadRowContent } from "./SidebarThreadRowContent";
import { ThreadArchiveActionButton } from "./ThreadArchiveActionButton";
import { ThreadDeleteActionButton } from "./ThreadDeleteActionButton";
import { ThreadPinToggleButton } from "./ThreadPinToggleButton";
import { ThreadRowTrailingCluster } from "./ThreadRowTrailingCluster";
import { SidebarMenuSubButton, SidebarMenuSubItem } from "./ui/sidebar";
import type { SidebarThreadSummary } from "~/types";

const NO_THREAD_IDS: ReadonlySet<string> = new Set();
const NO_PROJECT_IDS: ReadonlySet<ProjectId> = new Set();
const NO_PROJECT_SUMMARIES: ReadonlyMap<
  ProjectId,
  Pick<ProjectAgentSummary, "memberThreadIds">
> = new Map();

export function HostLabel(props: { host: string }) {
  return (
    <span className="flex min-w-0 shrink items-center gap-1 text-ui-xs text-muted-foreground/79">
      <ServerIcon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{props.host}</span>
    </span>
  );
}

function useHostThreadSummary(hostId: HostId, threadId: string): SidebarThreadSummary | undefined {
  return useSyncExternalStore(
    hostStores.subscribe,
    () => hostStores.peek(hostId)?.getState().sidebarThreadSummaryById[threadId as ThreadId],
  );
}

/** Confirms, then deletes a thread on its host; leaves the chat first when it is the open one. */
export async function confirmDeleteHostThread(input: {
  hostId: HostId;
  host: string | undefined;
  threadId: ThreadId;
  title: string;
  confirm: boolean;
  confirmDialog: (message: string) => Promise<boolean>;
  onDeleted: () => void;
}) {
  if (input.confirm) {
    const message = [
      `Delete thread "${input.title}"?`,
      "This permanently clears conversation history for this thread.",
    ].join("\n");
    if (!(await input.confirmDialog(message))) return;
  }
  try {
    await deleteHostThread(input.hostId, input.threadId);
    input.onDeleted();
  } catch (error) {
    toastManager.add({
      type: "error",
      title: `Could not delete the thread${input.host ? ` on ${input.host}` : ""}`,
      description: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The thread's detail (messages), which Fork and Handoff need, and a stop function. A thread
 * that has not run has none to load; one that is open already has it and keeps its own stream.
 */
async function loadThreadDetail(hostId: HostId, summary: SidebarThreadSummary) {
  const store = hostHandle(hostId).store;
  const read = () => getThreadFromState(store.getState(), summary.id);
  const loaded = () => (read()?.messages.length ?? 0) > 0;
  const api = apiFor(hostId);
  if (loaded() || summary.latestTurn === null || !api) return { thread: read(), stop: () => {} };
  const stop = followHostThread({ api: api.orchestration, store, threadId: summary.id });
  await new Promise<void>((resolve) => {
    const timer = window.setTimeout(done, 1_500);
    const unsubscribe = store.subscribe(() => {
      if (loaded()) done();
    });
    function done() {
      window.clearTimeout(timer);
      unsubscribe();
      resolve();
    }
  });
  return { thread: read(), stop };
}

type RowChildren = readonly RemoteCatalogThread[];

export function RemoteThreadRow(props: {
  hostId: HostId;
  host: string;
  thread: RemoteCatalogThread;
  activeThreadParam: string | null;
  /** Pinned rows sit flush left and name their host. */
  variant?: "standard" | "pinned";
}) {
  return (
    <HostScope hostId={props.hostId}>
      <RemoteThreadRowBody {...props} />
    </HostScope>
  );
}

function RemoteThreadRowBody(props: {
  hostId: HostId;
  host: string;
  thread: RemoteCatalogThread;
  activeThreadParam: string | null;
  variant?: "standard" | "pinned";
}) {
  const { hostId, host, thread: entry, activeThreadParam, variant = "standard" } = props;
  const threadId = entry.id as ThreadId;
  const scopedId = scopeThread(hostId, threadId);
  const summary = useHostThreadSummary(hostId, entry.id);
  const navigate = useNavigate();
  const { settings } = useAppSettings();
  const providerStatuses = useProviderStatusesForLocalConfig();
  const { continueThreadHandoff, createThreadHandoff, createTranscriptHandoff } =
    useThreadHandoff();
  const copyPath = useCopyPathToClipboard();
  const copyThreadId = useCopyThreadIdToClipboard();
  const nested = useNestedThreadsOpen(scopedId);
  const pinnedInStore = usePinnedThreadsStore((store) => store.pinnedThreadIds.includes(scopedId));
  const [dialog, setDialog] = useState<"rename" | "snooze" | null>(null);
  if (!summary) return null;

  const isPinned = pinnedInStore || summary.isPinned === true;
  const isActive = scopedId === activeThreadParam;
  const status = resolveThreadStatusPill({
    thread: summary,
    hasPendingApprovals: summary.hasPendingApprovals,
    hasPendingUserInput: summary.hasPendingUserInput,
  });
  const fail = (title: string, error: unknown) =>
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    });
  const open = () => void navigate({ to: "/$threadId", params: { threadId: scopedId } });

  const togglePinned = () => {
    const pins = usePinnedThreadsStore.getState();
    const next = !isPinned;
    if (next) pins.pinThread(scopedId);
    else pins.unpinThread(scopedId);
    void updateHostThreadMeta(hostId, threadId, { isPinned: next }).catch((error: unknown) => {
      if (next) pins.unpinThread(scopedId);
      else pins.pinThread(scopedId);
      fail(`Could not ${next ? "pin" : "unpin"} the thread on ${host}`, error);
    });
  };
  const deleteThread = () =>
    void confirmDeleteHostThread({
      hostId,
      host,
      threadId,
      title: summary.title,
      confirm: settings.confirmThreadDelete,
      confirmDialog: async (message) => {
        const api = apiFor(LOCAL_HOST_ID);
        return api ? api.dialogs.confirm(message) : window.confirm(message);
      },
      onDeleted: () => {
        if (isActive) void navigate({ to: "/" });
      },
    });
  const archiveThread = () =>
    void archiveThreadFromClient(hostHandle(hostId).requireApi().orchestration, threadId).then(
      () => {
        if (isActive) void navigate({ to: "/" });
      },
      (error: unknown) => fail(`Could not archive the thread on ${host}`, error),
    );
  const snooze = (until: Date | null) =>
    void dispatchThreadSnoozedUntil(threadId, until?.toISOString() ?? null, apiFor(hostId)).then(
      (confirmed) => {
        if (confirmed && until) {
          toastManager.add({
            type: "info",
            title: `Snoozed until ${formatSnoozeDeadline(until.toISOString())}`,
          });
        }
      },
    );

  const openMenu = async (position: { x: number; y: number }) => {
    const detail = await loadThreadDetail(hostId, summary);
    try {
      const { thread } = detail;
      const project = hostHandle(hostId)
        .store.getState()
        .projects.find((candidate) => candidate.id === summary.projectId);
      const availability = resolveThreadHandoffAvailability({
        isGroupContainer: false,
        isCoordinatorThread: false,
      });
      const canHandoff =
        thread !== undefined &&
        availability.providerHandoff &&
        canCreateThreadHandoff({
          thread,
          hasPendingApprovals: summary.hasPendingApprovals,
          hasPendingUserInput: summary.hasPendingUserInput,
        });
      const handoffInput = thread
        ? {
            sourceProvider: thread.modelSelection.provider,
            sourceProviderInstanceId:
              thread.session?.providerInstanceId ?? thread.modelSelection.instanceId,
            providerInstances: getProviderInstanceOptions(settings),
            providerStatuses,
          }
        : null;
      const handoffTargets =
        canHandoff && handoffInput ? resolveAvailableHandoffTargets(handoffInput) : [];
      const continueHandoffTargets = thread
        ? handoffTargets.filter((target) =>
            canContinueThreadHandoff({
              sourceProvider: thread.modelSelection.provider,
              targetProvider: target.provider,
            }),
          )
        : [];
      const transcriptHandoffTargets =
        canHandoff && handoffInput
          ? resolveAvailableHandoffTargets({ ...handoffInput, includeSource: true })
          : [];
      const workspacePath = resolveThreadWorkspaceCwd({
        projectCwd: project?.cwd ?? null,
        envMode: summary.envMode,
        worktreePath: summary.worktreePath,
      });
      const clearable =
        status?.dismissible === true && ["Completed", "Reminder"].includes(status.label);
      const clicked = await showReactContextMenu(
        buildThreadContextMenuItems({
          isPinned,
          hasDismissibleNotification: clearable,
          canSnooze: canSnoozeSidebarThread({
            thread: summary,
            groupProjectIds: NO_PROJECT_IDS,
            summariesByProjectId: NO_PROJECT_SUMMARIES,
            coordinatorThreadIds: NO_THREAD_IDS,
            membersLoaded: true,
          }),
          isSnoozed: summary.snoozedUntil != null,
          continueHandoffTargets,
          handoffTargets,
          transcriptHandoffTargets,
          canFork:
            thread !== undefined && canForkThread({ thread, handoffAvailability: availability }),
          hasWorkspacePath: Boolean(workspacePath),
          extraItems: [],
          // A hub links a project on this computer; it has no meaning for a host's project.
          hubItems: [],
          isSubagent: Boolean(summary.parentThreadId),
        }),
        position,
      );
      if (clicked === null) return;
      const store = hostHandle(hostId).store;
      const handoffLabels = new Map(
        [...handoffTargets, ...transcriptHandoffTargets].map((target) => [
          target.instanceId,
          target,
        ]),
      );
      const targetOf = (prefix: string) => handoffLabels.get(clicked.slice(prefix.length) as never);
      if (clicked === "rename") setDialog("rename");
      else if (clicked === "toggle-pin") togglePinned();
      else if (clicked === "mark-unread") store.getState().markThreadUnread(threadId);
      else if (clicked === "clear-notification") {
        const visitedAt =
          status?.label === "Completed"
            ? summary.latestTurn?.completedAt
            : summary.snoozeReminderAt;
        store.getState().markThreadVisited(threadId, visitedAt ?? undefined);
      } else if (clicked === "snooze-cancel") snooze(null);
      else if (clicked === "snooze-custom") setDialog("snooze");
      else if (SNOOZE_PRESETS.some((preset) => preset.id === clicked)) {
        const preset = SNOOZE_PRESETS.find((candidate) => candidate.id === clicked);
        if (preset) snooze(resolveSnoozeDeadline(preset.duration, Date.now()));
      } else if (clicked === "copy-path" || clicked === "open-path-in-terminal") {
        const api = apiFor(hostId);
        if (!workspacePath || !api) {
          toastManager.add({
            type: "error",
            title: "Path unavailable",
            description: "This thread does not have a workspace path.",
          });
        } else if (clicked === "copy-path") copyPath(workspacePath);
        else {
          await navigate({ to: "/$threadId", params: { threadId: scopedId } });
          await openPathInThreadTerminal({
            api,
            scopedThreadId: scopedId,
            threadId,
            path: workspacePath,
          });
        }
      } else if (clicked === "copy-thread-id") copyThreadId(threadId);
      else if (clicked === "fork:local" || clicked === "fork:worktree") {
        if (!thread) return;
        const api = hostHandle(hostId).requireApi();
        await dispatchThreadFork({
          api,
          sourceThread: thread,
          target: clicked === "fork:worktree" ? "worktree" : "local",
          rootBranch: null,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
        })
          .then(async (nextThreadId) => {
            store.getState().syncServerShellSnapshot(await api.orchestration.getShellSnapshot());
            await navigate({
              to: "/$threadId",
              params: { threadId: scopeThread(hostId, nextThreadId) },
            });
          })
          .catch((error: unknown) => fail("Could not fork thread", error));
      } else if (clicked.startsWith("handoff-here:") && thread) {
        const target = targetOf("handoff-here:");
        if (target)
          await continueThreadHandoff(thread, target.provider, target.instanceId).catch(
            (error: unknown) => fail("Could not hand off this thread", error),
          );
      } else if (clicked.startsWith("handoff-transcript:") && thread) {
        const target = targetOf("handoff-transcript:");
        if (target)
          await createTranscriptHandoff(thread, target.provider, target.instanceId).catch(
            (error: unknown) => fail("Could not start the transcript handoff", error),
          );
      } else if (clicked.startsWith("handoff:") && thread) {
        const target = targetOf("handoff:");
        if (target)
          await createThreadHandoff(thread, target.provider, target.instanceId).catch(
            (error: unknown) => fail("Could not create handoff thread", error),
          );
      } else if (clicked === "archive") archiveThread();
      else if (clicked === "delete") deleteThread();
    } finally {
      detail.stop();
    }
  };

  const tone = isActive ? "text-foreground/54 dark:text-foreground/64" : "text-muted-foreground/34";
  const pinned = variant === "pinned";
  const children: RowChildren = entry.children;
  return (
    <>
      <SidebarMenuSubItem className="group/thread-row w-full" data-thread-item>
        <SidebarMenuSubButton
          render={<div role="button" tabIndex={0} />}
          size="sm"
          isActive={isActive}
          aria-label={resolveThreadRowAriaLabel(summary)}
          className={cn(
            resolveThreadRowClassName({
              isActive,
              isSelected: false,
              isSnoozeReminder: status?.label === "Reminder",
            }),
            pinned ? "pl-2" : null,
            "pr-2",
          )}
          onClick={open}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setDialog("rename");
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            open();
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            void openMenu({ x: event.clientX, y: event.clientY });
          }}
        >
          <SidebarThreadRowContent
            thread={summary}
            terminalEntryPoint={false}
            terminalStatus={null}
            terminalCount={0}
            isActive={isActive}
            variant={variant}
            pendingStatusColorClass={
              status?.label === "Pending Approval" ? status.colorClass : null
            }
            titleAdornment={
              children.length > 0 ? (
                <NestedThreadsToggle open={nested.open} onToggle={nested.toggle} />
              ) : undefined
            }
            suffix={pinned ? <HostLabel host={host} /> : undefined}
          />
          <div className="flex min-w-0 items-center">
            <ThreadRowTrailingCluster
              threadJumpLabel={null}
              rightMetaChips={[]}
              prChip={null}
              threadStatus={status}
              timestampToneClassName={tone}
              hoverActions={
                <SidebarRowHoverActions threadId={scopedId}>
                  <div className="pointer-events-auto inline-flex items-center gap-2">
                    <ThreadPinToggleButton
                      pinned={isPinned}
                      presentation="inline"
                      toneClassName={tone}
                      onToggle={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        togglePinned();
                      }}
                    />
                    {summary.parentThreadId ? null : (
                      <ThreadArchiveActionButton
                        threadId={threadId}
                        toneClassName={tone}
                        onArchive={archiveThread}
                      />
                    )}
                    <ThreadDeleteActionButton
                      threadId={threadId}
                      toneClassName={tone}
                      onDelete={deleteThread}
                    />
                  </div>
                </SidebarRowHoverActions>
              }
            />
          </div>
        </SidebarMenuSubButton>
        {dialog === "rename" ? (
          <RenameThreadDialog
            open
            currentTitle={summary.title}
            onOpenChange={(next) => {
              if (!next) setDialog(null);
            }}
            onSave={async (title) => {
              const trimmed = title.trim();
              if (trimmed.length === 0 || trimmed === summary.title) return;
              await updateHostThreadMeta(hostId, threadId, { title: trimmed }).catch(
                (error: unknown) => fail(`Could not rename the thread on ${host}`, error),
              );
            }}
          />
        ) : null}
        {dialog === "snooze" ? (
          <SnoozeUntilDialog
            open
            currentSnoozedUntil={summary.snoozedUntil ?? null}
            onOpenChange={(next) => {
              if (!next) setDialog(null);
            }}
            onSnooze={(deadline) => snooze(resolveSnoozeDeadline(deadline, Date.now()))}
          />
        ) : null}
      </SidebarMenuSubItem>
      {children.length > 0 ? (
        <SidebarNestedThreads
          open={nested.open}
          summary={summarizeRemoteChildren(hostId, children)}
          onToggle={nested.toggle}
        >
          {children.map((child) => (
            <RemoteThreadRow
              key={child.id}
              hostId={hostId}
              host={host}
              thread={child}
              activeThreadParam={activeThreadParam}
            />
          ))}
        </SidebarNestedThreads>
      ) : null}
    </>
  );
}

function flattenCatalogThreads(threads: RowChildren): RemoteCatalogThread[] {
  return threads.flatMap((thread) => [thread, ...flattenCatalogThreads(thread.children)]);
}

/** Counts a parent's nested sessions (all depths) and the failed ones from the host store. */
function summarizeRemoteChildren(hostId: HostId, children: RowChildren) {
  const summaries = hostStores.peek(hostId)?.getState().sidebarThreadSummaryById ?? {};
  const all = flattenCatalogThreads(children);
  return {
    count: all.length,
    failed: all.filter((child) => {
      const summary = summaries[child.id as ThreadId];
      return summary !== undefined && resolveSubagentThreadStatusKind(summary) === "failed";
    }).length,
  };
}

export interface RemotePinnedThread {
  readonly hostId: HostId;
  readonly thread: RemoteCatalogThread;
}

/** A thread still on the list: not archived or snoozed. */
const live = (summary: SidebarThreadSummary | undefined): summary is SidebarThreadSummary =>
  summary !== undefined && !summary.archivedAt && summary.snoozedUntil == null;

let pinnedCache: { inputs: readonly unknown[]; result: readonly RemotePinnedThread[] } | null =
  null;

/** Pinned threads of connected hosts, in pin order, for the sidebar's Pinned section. */
function readRemotePinnedThreads(): readonly RemotePinnedThread[] {
  const pins = usePinnedThreadsStore.getState().pinnedThreadIds;
  const hostIds = hostStores
    .hostIds()
    .filter((hostId) => hostId !== LOCAL_HOST_ID && hostStores.status(hostId).status === "live");
  const inputs = [
    pins,
    ...hostIds.flatMap((hostId) => [
      hostId,
      hostStores.get(hostId).getState().sidebarThreadSummaryById,
    ]),
  ];
  if (
    pinnedCache &&
    pinnedCache.inputs.length === inputs.length &&
    pinnedCache.inputs.every((input, index) => input === inputs[index])
  ) {
    return pinnedCache.result;
  }
  const entry = (hostId: HostId, summary: SidebarThreadSummary): RemotePinnedThread => ({
    hostId,
    thread: {
      id: summary.id,
      title: summary.title,
      state: threadState(summary),
      updatedAt: summary.updatedAt ?? "",
      children: [],
    },
  });
  const seen = new Set<string>();
  const result: RemotePinnedThread[] = [];
  for (const scoped of pins) {
    const ref = unscopeThread(scoped);
    if (!hostIds.includes(ref.hostId)) continue;
    const summary = hostStores.get(ref.hostId).getState().sidebarThreadSummaryById[ref.threadId];
    if (!live(summary)) continue;
    seen.add(scoped);
    result.push(entry(ref.hostId, summary));
  }
  // Pinned on the host itself (its own sidebar) but not yet here.
  for (const hostId of hostIds) {
    for (const summary of Object.values(
      hostStores.get(hostId).getState().sidebarThreadSummaryById,
    )) {
      if (
        summary.isPinned === true &&
        live(summary) &&
        !seen.has(scopeThread(hostId, summary.id))
      ) {
        result.push(entry(hostId, summary));
      }
    }
  }
  pinnedCache = { inputs, result };
  return result;
}

function subscribeRemotePinnedThreads(listener: () => void): () => void {
  const stopHosts = hostStores.subscribe(listener);
  const stopPins = usePinnedThreadsStore.subscribe(listener);
  return () => {
    stopHosts();
    stopPins();
  };
}

export function useRemotePinnedThreads(): readonly RemotePinnedThread[] {
  return useSyncExternalStore(subscribeRemotePinnedThreads, readRemotePinnedThreads);
}
