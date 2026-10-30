// FILE: RemoteHostsSidebarSection.tsx
// Purpose: Connected SSH hosts in the sidebar: their projects and threads in the Projects list,
//          their running chats under Activity, and Add project on a host. A host's chats open in
//          this window by host-qualified route id.
// Layer: Sidebar UI (renders only while the remote SSH bridge reports hosts)
// Exports: RemoteHostProjects, RemoteHostActivity, RemoteHostStoreSync, AddProjectOnHostButton,
//          useRemoteChatNeedsAnswer

import {
  ProjectId,
  ThreadId,
  type DesktopRemoteSshHostState,
  type DesktopRemoteSshState,
} from "@saint/contracts";
import { scopeThread, sshHostId, type HostId } from "@saint/shared/hostId";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Schema } from "effect";
import { useSyncExternalStore } from "react";

import { useAppSettings } from "~/appSettings";
import { toastManager } from "~/components/ui/toast";
import { useRemoteHostCatalog } from "~/hooks/useRemoteHostCatalog";
import { useRemoteHostStoreSync } from "~/hooks/useRemoteHostStoreSync";
import { useRemoteSshState } from "~/hooks/useRemoteSshState";
import { hostStores } from "~/hosts/hostStores";
import { useHostThreadActions } from "~/hooks/useHostThreadActions";
import { addHostProject, deleteHostThread, removeHostProject } from "~/hosts/hostThreadCreate";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { THREAD_CONTEXT_MENU_ICONS } from "~/lib/contextMenuIcons";
import { readLocalNativeApi } from "~/nativeApi";
import { DisclosureChevron } from "./ui/DisclosureChevron";
import { AddPlusIcon, FolderIcon, MonitorIcon, NewThreadIcon, ServerIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  connectedRemoteHosts,
  remoteHostSidebarStatus,
  threadState,
  type RemoteCatalogThread,
  type RemoteCatalogThreadState,
  type RemoteHostSidebarStatus,
} from "~/lib/remoteHostCatalog";
import {
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
  SIDEBAR_THREAD_ROW_BASE_CLASS_NAME,
} from "~/sidebarRowStyles";
import { remoteHostRows, remoteHostStatus } from "./settings/remoteHostsSettingsModel";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME } from "./sidebarContextMenuStyles";
import { SidebarIconButton } from "./SidebarIconButton";
import { SidebarRowHoverActions } from "./SidebarRowHoverActions";
import { ThreadDeleteActionButton } from "./ThreadDeleteActionButton";
import { Menu, MenuItem, MenuTrigger } from "./ui/menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const STATUS_DOT_CLASS_NAME: Record<RemoteHostSidebarStatus, string> = {
  connected: "bg-success",
  connecting: "bg-warning animate-pulse",
  error: "bg-destructive",
  offline: "bg-muted-foreground/40",
};

const THREAD_DOT_CLASS_NAME: Record<RemoteCatalogThreadState, string> = {
  running: "bg-info animate-pulse",
  attention: "bg-warning",
  idle: "bg-transparent",
};

function StatusDot(props: { className: string }) {
  return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", props.className)} />;
}

/** Confirms, then deletes a thread on its host; leaves the chat first when it is the open one. */
async function confirmDeleteHostThread(input: {
  hostId: HostId;
  host: string | undefined;
  thread: RemoteCatalogThread;
  confirm: boolean;
  onDeleted: () => void;
}) {
  const api = readLocalNativeApi();
  if (input.confirm) {
    const message = [
      `Delete thread "${input.thread.title}"?`,
      "This permanently clears conversation history for this thread.",
    ].join("\n");
    if (!(api ? await api.dialogs.confirm(message) : window.confirm(message))) return;
  }
  try {
    await deleteHostThread(input.hostId, ThreadId.makeUnsafe(input.thread.id));
    input.onDeleted();
  } catch (error) {
    toastManager.add({
      type: "error",
      title: `Could not delete the thread${input.host ? ` on ${input.host}` : ""}`,
      description: error instanceof Error ? error.message : String(error),
    });
  }
}

/** A host's thread; it opens in this window by its host-qualified route id. */
function RemoteThreadRow(props: {
  hostId: HostId;
  thread: RemoteCatalogThread;
  activeThreadParam: string | null;
  /** Names the host on the row, for lists that do not group by host. */
  host?: string;
  indentClassName?: string;
}) {
  const { hostId, thread, activeThreadParam, host, indentClassName = "pl-5" } = props;
  const navigate = useNavigate();
  const { settings } = useAppSettings();
  const param = scopeThread(hostId, ThreadId.makeUnsafe(thread.id));
  const deleteThread = () =>
    void confirmDeleteHostThread({
      hostId,
      host,
      thread,
      confirm: settings.confirmThreadDelete,
      onDeleted: () => {
        if (param === activeThreadParam) void navigate({ to: "/" });
      },
    });
  return (
    <div className="group/thread-row relative w-full">
      <SidebarMenuButton
        size="sm"
        isActive={param === activeThreadParam}
        className={cn(
          SIDEBAR_THREAD_ROW_BASE_CLASS_NAME,
          "gap-1.5",
          indentClassName,
          SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
          SIDEBAR_ROW_HOVER_CLASS_NAME,
        )}
        onClick={() => void navigate({ to: "/$threadId", params: { threadId: param } })}
        onContextMenu={(event) => {
          event.preventDefault();
          const api = readLocalNativeApi();
          if (!api) return;
          void api.contextMenu
            .show(
              [
                {
                  id: "delete",
                  label: "Delete",
                  icon: THREAD_CONTEXT_MENU_ICONS.delete,
                  destructive: true,
                },
              ],
              { x: event.clientX, y: event.clientY },
            )
            .then((clicked) => {
              if (clicked === "delete") deleteThread();
            });
        }}
      >
        <span className="min-w-0 flex-1 truncate">{thread.title}</span>
        {host ? <HostLabel host={host} /> : null}
        <StatusDot className={THREAD_DOT_CLASS_NAME[thread.state]} />
      </SidebarMenuButton>
      <SidebarRowHoverActions threadId={param}>
        <ThreadDeleteActionButton threadId={param} onDelete={deleteThread} />
      </SidebarRowHoverActions>
    </div>
  );
}

function HostLabel(props: { host: string }) {
  return (
    <span className="flex min-w-0 shrink items-center gap-1 text-ui-xs text-muted-foreground/79">
      <ServerIcon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{props.host}</span>
    </span>
  );
}

const COLLAPSED_STORAGE_KEY = "saint:sidebar:remote-collapsed";
const CollapsedKeys = Schema.Array(Schema.String);

/** Which host groups and remote projects are collapsed, remembered across reloads. */
function useRemoteCollapsed() {
  const [collapsed, setCollapsed] = useLocalStorage(COLLAPSED_STORAGE_KEY, [], CollapsedKeys);
  const toggle = (key: string) =>
    setCollapsed((current) =>
      current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key],
    );
  return { isCollapsed: (key: string) => collapsed.includes(key), toggle };
}

async function confirmRemoveHostProject(input: {
  hostId: HostId;
  host: string;
  projectId: string;
  title: string;
  threadCount: number;
  position: { x: number; y: number };
}) {
  const api = readLocalNativeApi();
  if (!api) return;
  const clicked = await api.contextMenu.show(
    [{ id: "remove", label: "Remove from Saint", icon: THREAD_CONTEXT_MENU_ICONS.delete }],
    input.position,
  );
  if (clicked !== "remove") return;
  const confirmed = await api.dialogs.confirm(
    [
      `Remove project "${input.title}" from ${input.host}?`,
      input.threadCount > 0
        ? `This deletes its ${input.threadCount} ${input.threadCount === 1 ? "thread" : "threads"} in Saint. The folder on ${input.host} is not touched.`
        : `The folder on ${input.host} is not touched.`,
    ].join("\n"),
  );
  if (!confirmed) return;
  try {
    await removeHostProject(input.hostId, ProjectId.makeUnsafe(input.projectId));
  } catch (error) {
    toastManager.add({
      type: "error",
      title: `Could not remove the project on ${input.host}`,
      description: error instanceof Error ? error.message : String(error),
    });
  }
}

/** One host's group: a header that collapses it, then its projects and their threads. */
function RemoteHostGroup(props: {
  host: string;
  hostKey: string;
  hostState: DesktopRemoteSshHostState | null;
  activeThreadParam: string | null;
  collapsed: ReturnType<typeof useRemoteCollapsed>;
}) {
  const { host, hostKey, hostState, activeThreadParam, collapsed } = props;
  const hostId = sshHostId(hostKey);
  const status = remoteHostSidebarStatus(hostState);
  const catalog = useRemoteHostCatalog(hostKey);
  // Offline hosts keep their last known rows, dimmed; their chats open read-only.
  const offline = status !== "connected" || catalog.status === "error";
  const label = `${host} · ${remoteHostStatus(hostState)}`;
  const { startThread } = useHostThreadActions();
  const hostCollapseKey = `host:${hostKey}`;
  const hostOpen = !collapsed.isCollapsed(hostCollapseKey);

  return (
    <SidebarMenuItem className={cn("rounded-md", offline && "opacity-60")}>
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              size="sm"
              aria-expanded={hostOpen}
              className={cn(
                SIDEBAR_HEADER_ROW_CLASS_NAME,
                SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
                SIDEBAR_ROW_HOVER_CLASS_NAME,
                "min-w-0",
              )}
              onClick={() => collapsed.toggle(hostCollapseKey)}
            />
          }
        >
          <ServerIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/79" />
          <span className="min-w-0 flex-1 truncate">{host}</span>
          <StatusDot
            className={
              STATUS_DOT_CLASS_NAME[
                status === "connected" && catalog.status === "error" ? "error" : status
              ]
            }
          />
          <DisclosureChevron open={hostOpen} className="size-3.5 shrink-0" />
        </TooltipTrigger>
        <TooltipPopup side="right">{catalog.message ?? label}</TooltipPopup>
      </Tooltip>
      {hostOpen ? (
        <SidebarMenu className={cn(SIDEBAR_NESTED_LIST_GAP_CLASS_NAME, "pt-0.5")}>
          {catalog.projects.map((project) => {
            const projectCollapseKey = `project:${hostKey}:${project.id}`;
            const projectOpen = !collapsed.isCollapsed(projectCollapseKey);
            return (
              <SidebarMenuItem key={project.id} className="rounded-md">
                <div className="flex items-center gap-0.5">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <SidebarMenuButton
                          size="sm"
                          aria-expanded={projectOpen}
                          className={cn(
                            SIDEBAR_HEADER_ROW_CLASS_NAME,
                            SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
                            SIDEBAR_ROW_HOVER_CLASS_NAME,
                            "min-w-0 flex-1 pl-4",
                          )}
                          onClick={() => collapsed.toggle(projectCollapseKey)}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            if (offline) return;
                            void confirmRemoveHostProject({
                              hostId,
                              host,
                              projectId: project.id,
                              title: project.title,
                              threadCount: project.threads.length + project.hiddenThreadCount,
                              position: { x: event.clientX, y: event.clientY },
                            });
                          }}
                        />
                      }
                    >
                      <FolderIcon
                        aria-hidden
                        className="size-3.5 shrink-0 text-muted-foreground/79"
                      />
                      <span className="min-w-0 flex-1 truncate">{project.title}</span>
                    </TooltipTrigger>
                    <TooltipPopup side="right">{`${host}:${project.workspaceRoot}`}</TooltipPopup>
                  </Tooltip>
                  {offline ? null : (
                    <SidebarIconButton
                      icon={NewThreadIcon}
                      label={`New thread in ${project.title} on ${host}`}
                      tooltip={`New thread on ${host}`}
                      tooltipSide="right"
                      onClick={() =>
                        void startThread(hostId, host, ProjectId.makeUnsafe(project.id))
                      }
                    />
                  )}
                </div>
                {projectOpen ? (
                  <SidebarMenu className={cn(SIDEBAR_NESTED_LIST_GAP_CLASS_NAME, "pt-0.5")}>
                    {project.threads.map((thread) => (
                      <RemoteThreadRow
                        key={thread.id}
                        hostId={hostId}
                        thread={thread}
                        activeThreadParam={activeThreadParam}
                        indentClassName="pl-8"
                      />
                    ))}
                    {project.hiddenThreadCount > 0 ? (
                      <div className="px-2 py-1 pl-8 text-ui-sm text-muted-foreground/58">
                        {`+${project.hiddenThreadCount} more on ${host}`}
                      </div>
                    ) : null}
                  </SidebarMenu>
                ) : null}
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      ) : null}
    </SidebarMenuItem>
  );
}

function useActiveThreadParam(): string | null {
  return useParams({
    strict: false,
    select: (params) => (params as { threadId?: string }).threadId ?? null,
  });
}

/**
 * Keeps every connected host's store fed for the app's lifetime, so a host's open chat, its
 * notifications and the quit check stay live whichever sidebar view is showing.
 */
export function RemoteHostStoreSync() {
  const state = useRemoteSshState();
  return state ? <RemoteHostStoreSyncFor state={state} /> : null;
}

function RemoteHostStoreSyncFor(props: { state: DesktopRemoteSshState }) {
  useRemoteHostStoreSync(props.state);
  return null;
}

/** The Remote area: one collapsible group per host, after this computer's projects. */
export function RemoteHostProjects(props: { state: DesktopRemoteSshState }) {
  const activeThreadParam = useActiveThreadParam();
  const collapsed = useRemoteCollapsed();
  return remoteHostRows(props.state).map((row) => {
    const hostKey =
      row.state?.hostKey ??
      props.state.savedHosts.find((saved) => saved.host === row.host)?.hostKey ??
      null;
    if (!hostKey) return null;
    return (
      <RemoteHostGroup
        key={row.host}
        host={row.host}
        hostKey={hostKey}
        hostState={row.state}
        activeThreadParam={activeThreadParam}
        collapsed={collapsed}
      />
    );
  });
}

function remoteChatNeedsAnswer(activeThreadParam: string | null): boolean {
  return hostStores
    .hostIds()
    .some(
      (hostId) =>
        hostStores.status(hostId).status === "live" &&
        Object.values(hostStores.get(hostId).getState().sidebarThreadSummaryById).some(
          (thread) =>
            !thread.archivedAt &&
            threadState(thread) === "attention" &&
            scopeThread(hostId, thread.id) !== activeThreadParam,
        ),
    );
}

/**
 * True while a connected host's chat other than the open one waits on an approval or an
 * answer (the Activity bell dot, which leaves out the open chat like this computer's do).
 */
export function useRemoteChatNeedsAnswer(): boolean {
  const activeThreadParam = useActiveThreadParam();
  return useSyncExternalStore(hostStores.subscribe, () => remoteChatNeedsAnswer(activeThreadParam));
}

const ACTIVITY_ORDER: Record<RemoteCatalogThreadState, number> = {
  attention: 0,
  running: 1,
  idle: 2,
};

/** A connected host's chats that need an answer or are running, those needing an answer first. */
function RemoteHostActivityRows(props: {
  host: string;
  hostKey: string;
  hostState: DesktopRemoteSshHostState | null;
  activeThreadParam: string | null;
}) {
  const { host, hostKey, hostState, activeThreadParam } = props;
  const connected = remoteHostSidebarStatus(hostState) === "connected";
  const catalog = useRemoteHostCatalog(hostKey);
  if (!connected) return null;
  const hostId = sshHostId(hostKey);
  const threads = catalog.projects
    .flatMap((project) => project.threads)
    .filter((thread) => thread.state !== "idle")
    .toSorted(
      (a, b) =>
        ACTIVITY_ORDER[a.state] - ACTIVITY_ORDER[b.state] || b.updatedAt.localeCompare(a.updatedAt),
    );
  return threads.map((thread) => (
    <SidebarMenuItem key={`${hostKey}:${thread.id}`} className="rounded-md">
      <RemoteThreadRow
        hostId={hostId}
        thread={thread}
        activeThreadParam={activeThreadParam}
        host={host}
      />
    </SidebarMenuItem>
  ));
}

/** Connected hosts' running and waiting chats, under this computer's Activity view. */
export function RemoteHostActivity(props: { state: DesktopRemoteSshState }) {
  const activeThreadParam = useActiveThreadParam();
  return remoteHostRows(props.state).map((row) =>
    row.state?.hostKey ? (
      <RemoteHostActivityRows
        key={row.host}
        host={row.host}
        hostKey={row.state.hostKey}
        hostState={row.state}
        activeThreadParam={activeThreadParam}
      />
    ) : null,
  );
}

/**
 * The Projects list's Add project button. With a connected host it asks where the folder
 * lives: this computer (the usual flow) or the host, whose folders the remote picker browses.
 */
export function AddProjectOnHostButton(props: {
  state: DesktopRemoteSshState | null;
  onAddLocal: () => void;
}) {
  const hosts = connectedRemoteHosts(props.state);
  if (hosts.length === 0) {
    return (
      <SidebarIconButton
        icon={AddPlusIcon}
        label="Add project"
        onClick={props.onAddLocal}
        tooltip="Add project"
        tooltipSide="right"
      />
    );
  }
  const addOnHost = async (hostId: HostId, host: string) => {
    try {
      await addHostProject(hostId, host);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Could not add the project on ${host}`,
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };
  return (
    <Menu>
      <SidebarIconButton
        render={<MenuTrigger />}
        icon={AddPlusIcon}
        label="Add project"
        tooltip="Add project"
        tooltipSide="right"
      />
      <ComposerPickerMenuPopup align="end" side="bottom" className="min-w-44">
        <MenuItem className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME} onClick={props.onAddLocal}>
          <MonitorIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">This computer</span>
        </MenuItem>
        {hosts.map(({ host, hostId }) => (
          <MenuItem
            key={hostId}
            className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}
            onClick={() => void addOnHost(hostId, host)}
          >
            <ServerIcon aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{host}</span>
          </MenuItem>
        ))}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
