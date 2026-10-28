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
import { useSyncExternalStore } from "react";

import { toastManager } from "~/components/ui/toast";
import { useRemoteHostCatalog } from "~/hooks/useRemoteHostCatalog";
import { useRemoteHostStoreSync } from "~/hooks/useRemoteHostStoreSync";
import { useRemoteSshState } from "~/hooks/useRemoteSshState";
import { hostStores } from "~/hosts/hostStores";
import { addHostProject, createHostThread } from "~/hosts/hostThreadCreate";
import { AddPlusIcon, FolderIcon, MonitorIcon, NewThreadIcon, ServerIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
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

/** A host's thread; it opens in this window by its host-qualified route id. */
function RemoteThreadRow(props: {
  hostId: HostId;
  thread: RemoteCatalogThread;
  activeThreadParam: string | null;
  /** Names the host on the row, for lists that do not group by host. */
  host?: string;
}) {
  const { hostId, thread, activeThreadParam, host } = props;
  const navigate = useNavigate();
  const param = scopeThread(hostId, ThreadId.makeUnsafe(thread.id));
  return (
    <SidebarMenuButton
      size="sm"
      isActive={param === activeThreadParam}
      className={cn(
        SIDEBAR_THREAD_ROW_BASE_CLASS_NAME,
        "gap-1.5 pl-5",
        SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
        SIDEBAR_ROW_HOVER_CLASS_NAME,
      )}
      onClick={() => void navigate({ to: "/$threadId", params: { threadId: param } })}
    >
      <span className="min-w-0 flex-1 truncate">{thread.title}</span>
      {host ? <HostLabel host={host} /> : null}
      <StatusDot className={THREAD_DOT_CLASS_NAME[thread.state]} />
    </SidebarMenuButton>
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

/** A host's projects as rows of the main Projects list, each labeled with the host. */
function RemoteHostProjectRows(props: {
  host: string;
  hostKey: string;
  hostState: DesktopRemoteSshHostState | null;
  activeThreadParam: string | null;
}) {
  const { host, hostKey, hostState, activeThreadParam } = props;
  const navigate = useNavigate();
  const hostId = sshHostId(hostKey);
  const status = remoteHostSidebarStatus(hostState);
  const catalog = useRemoteHostCatalog(hostKey);
  // Offline hosts keep their last known rows, dimmed; their chats open read-only.
  const offline = status !== "connected" || catalog.status === "error";
  const label = `${host} · ${remoteHostStatus(hostState)}`;
  const startThread = async (projectId: ProjectId) => {
    try {
      const threadId = await createHostThread(hostId, projectId);
      await navigate({ to: "/$threadId", params: { threadId: scopeThread(hostId, threadId) } });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Could not start a thread on ${host}`,
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return catalog.projects.map((project) => (
    <SidebarMenuItem
      key={`${hostKey}:${project.id}`}
      className={cn("rounded-md", offline && "opacity-60")}
    >
      <div className="flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarMenuButton
                size="sm"
                className={cn(
                  SIDEBAR_HEADER_ROW_CLASS_NAME,
                  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
                  SIDEBAR_ROW_HOVER_CLASS_NAME,
                  "min-w-0 flex-1 cursor-default",
                )}
              />
            }
          >
            <FolderIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/79" />
            <span className="min-w-0 flex-1 truncate">{project.title}</span>
            <HostLabel host={host} />
            <StatusDot
              className={
                STATUS_DOT_CLASS_NAME[
                  status === "connected" && catalog.status === "error" ? "error" : status
                ]
              }
            />
          </TooltipTrigger>
          <TooltipPopup side="right">
            <div>{`${host}:${project.workspaceRoot}`}</div>
            <div className="text-muted-foreground">{catalog.message ?? label}</div>
          </TooltipPopup>
        </Tooltip>
        {offline ? null : (
          <SidebarIconButton
            icon={NewThreadIcon}
            label={`New thread in ${project.title} on ${host}`}
            tooltip={`New thread on ${host}`}
            tooltipSide="right"
            onClick={() => void startThread(ProjectId.makeUnsafe(project.id))}
          />
        )}
      </div>
      <SidebarMenu className={cn(SIDEBAR_NESTED_LIST_GAP_CLASS_NAME, "pt-0.5")}>
        {project.threads.map((thread) => (
          <RemoteThreadRow
            key={thread.id}
            hostId={hostId}
            thread={thread}
            activeThreadParam={activeThreadParam}
          />
        ))}
        {project.hiddenThreadCount > 0 ? (
          <div className="px-2 py-1 pl-5 text-ui-sm text-muted-foreground/58">
            {`+${project.hiddenThreadCount} more on ${host}`}
          </div>
        ) : null}
      </SidebarMenu>
    </SidebarMenuItem>
  ));
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

/** Every host's projects in the main Projects list, after this computer's. */
export function RemoteHostProjects(props: { state: DesktopRemoteSshState }) {
  const activeThreadParam = useActiveThreadParam();
  return remoteHostRows(props.state).map((row) => {
    const hostKey =
      row.state?.hostKey ??
      props.state.savedHosts.find((saved) => saved.host === row.host)?.hostKey ??
      null;
    if (!hostKey) return null;
    return (
      <RemoteHostProjectRows
        key={row.host}
        host={row.host}
        hostKey={hostKey}
        hostState={row.state}
        activeThreadParam={activeThreadParam}
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
  const hosts = (props.state ? remoteHostRows(props.state) : []).flatMap((row) =>
    row.state?.hostKey && remoteHostSidebarStatus(row.state) === "connected"
      ? [{ host: row.host, hostId: sshHostId(row.state.hostKey) }]
      : [],
  );
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
