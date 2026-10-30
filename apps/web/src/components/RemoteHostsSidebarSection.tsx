// FILE: RemoteHostsSidebarSection.tsx
// Purpose: Connected SSH hosts in the sidebar: their projects and threads in the Projects list,
//          their running chats under Activity, and Add project on a host. A host's chats open in
//          this window by host-qualified route id.
// Layer: Sidebar UI (renders only while the remote SSH bridge reports hosts)
// Exports: RemoteHostProjects, RemoteHostActivity, RemoteHostStoreSync, AddProjectOnHostButton,
//          useRemoteChatNeedsAnswer

import {
  ProjectId,
  type DesktopRemoteSshHostState,
  type DesktopRemoteSshState,
} from "@saint/contracts";
import { MAX_PINNED_PROJECTS } from "@saint/contracts";
import { scopeProject, scopeThread, sshHostId, type HostId } from "@saint/shared/hostId";
import { useParams } from "@tanstack/react-router";
import { Schema } from "effect";
import { useState, useSyncExternalStore } from "react";

import { toastManager } from "~/components/ui/toast";
import { useRemoteHostCatalog } from "~/hooks/useRemoteHostCatalog";
import { useRemoteHostStoreSync } from "~/hooks/useRemoteHostStoreSync";
import { useRemoteSshState } from "~/hooks/useRemoteSshState";
import { hostStores } from "~/hosts/hostStores";
import { useHostThreadActions } from "~/hooks/useHostThreadActions";
import {
  addHostProject,
  removeHostProject,
  renameHostProject,
  setHostProjectPinned,
} from "~/hosts/hostThreadCreate";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useCopyPathToClipboard } from "~/hooks/useCopyToClipboard";
import { PinStatusIcon, pinActionLabel } from "~/lib/pin";
import { usePinnedProjectsStore } from "~/pinnedProjectsStore";
import { readLocalNativeApi } from "~/nativeApi";
import { DisclosureChevron } from "./ui/DisclosureChevron";
import {
  AddPlusIcon,
  FolderIcon,
  MonitorIcon,
  NewThreadIcon,
  ServerIcon,
  TrashCanIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  connectedRemoteHosts,
  remoteHostSidebarStatus,
  threadState,
  type RemoteCatalogProject,
  type RemoteCatalogThread,
  type RemoteCatalogThreadState,
  type RemoteHostSidebarStatus,
} from "~/lib/remoteHostCatalog";
import {
  SIDEBAR_HEADER_LEADING_ACTION_CLASS_NAME,
  SIDEBAR_HEADER_LEADING_ACTION_REVEAL_CLASS_NAME,
  SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
  sidebarHoverRevealHideClassName,
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
} from "~/sidebarRowStyles";
import { remoteHostRows, remoteHostStatus } from "./settings/remoteHostsSettingsModel";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { ProjectContextMenu, type ProjectContextMenuId } from "./ProjectContextMenu";
import { RelocateProjectDialog } from "./RelocateProjectDialog";
import { RenameDialog } from "./RenameDialog";
import { RemoteThreadRow } from "./RemoteThreadRow";
import { SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME } from "./sidebarContextMenuStyles";
import { SidebarSectionToolbar } from "./SidebarSectionToolbar";
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

function StatusDot(props: { className: string }) {
  return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", props.className)} />;
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

/** Confirms, then removes a project from its host's Saint; the folder on the host is kept. */
async function confirmRemoveHostProject(input: {
  hostId: HostId;
  host: string;
  projectId: string;
  title: string;
  threadCount: number;
}) {
  const api = readLocalNativeApi();
  if (!api) return;
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

/**
 * A host's project: its header, the same right-click menu as this computer's projects (minus
 * what needs the folder on this machine), hover actions, and its threads.
 */
function RemoteProjectRow(props: {
  hostId: HostId;
  host: string;
  hostKey: string;
  project: RemoteCatalogProject;
  offline: boolean;
  activeThreadParam: string | null;
  collapsed: ReturnType<typeof useRemoteCollapsed>;
}) {
  const { hostId, host, hostKey, project, offline, activeThreadParam, collapsed } = props;
  const { startThread } = useHostThreadActions();
  const copyPathToClipboard = useCopyPathToClipboard();
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<"rename" | "relocate" | null>(null);
  const projectId = ProjectId.makeUnsafe(project.id);
  const projectCollapseKey = `project:${hostKey}:${project.id}`;
  const projectOpen = !collapsed.isCollapsed(projectCollapseKey);
  const scopedProjectId = scopeProject(hostId, projectId);
  // Pinned here, or on the host itself; both the store and the host's flag are reactive.
  const pinned = usePinnedProjectsStore((store) =>
    store.pinnedProjectIds.includes(scopedProjectId),
  );
  const isPinned = pinned || project.isPinned;
  const fail = (title: string, error: unknown) =>
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    });
  const togglePin = async () => {
    const scoped = scopedProjectId;
    const pinned = isPinned;
    const pins = usePinnedProjectsStore.getState();
    if (pinned) pins.unpinProject(scoped);
    else if (!pins.pinProject(scoped)) {
      toastManager.add({
        type: "warning",
        title: "Project pin limit reached",
        description: `You can pin up to ${MAX_PINNED_PROJECTS} projects.`,
      });
      return;
    }
    try {
      await setHostProjectPinned(hostId, projectId, !pinned);
    } catch (error) {
      if (pinned) pins.pinProject(scoped);
      else pins.unpinProject(scoped);
      fail(`Could not ${pinned ? "unpin" : "pin"} the project on ${host}`, error);
    }
  };
  const removeProject = () =>
    void confirmRemoveHostProject({
      hostId,
      host,
      projectId: project.id,
      title: project.title,
      threadCount: project.threads.length + project.hiddenThreadCount,
    });
  const onAction = (id: ProjectContextMenuId) => {
    setMenuPosition(null);
    if (id === "copy-path") copyPathToClipboard(project.workspaceRoot);
    else if (id === "rename") setDialog("rename");
    else if (id === "relocate") setDialog("relocate");
    else if (id === "toggle-pin") void togglePin();
    else if (id === "delete") removeProject();
  };
  return (
    <SidebarMenuItem className="rounded-md">
      <div className="group/project-header relative">
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
                  offline
                    ? null
                    : "group-hover/project-header:pr-[3.5rem] project-header-focus:pr-[3.5rem]",
                )}
                onClick={() => collapsed.toggle(projectCollapseKey)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  if (offline) return;
                  setMenuPosition({ x: event.clientX, y: event.clientY });
                }}
              />
            }
          >
            <FolderIcon
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground/79",
                isPinned ? "opacity-0" : sidebarHoverRevealHideClassName("project-header"),
              )}
            />
            <span className="min-w-0 flex-1 truncate">{project.title}</span>
          </TooltipTrigger>
          <TooltipPopup side="right">{`${host}:${project.workspaceRoot}`}</TooltipPopup>
        </Tooltip>
        {offline ? null : (
          // The pin covers a pinned project's folder; unpinned, it shows on hover in its place.
          <button
            type="button"
            aria-label={pinActionLabel(project.title, isPinned)}
            aria-pressed={isPinned}
            title={pinActionLabel(project.title, isPinned)}
            className={cn(
              SIDEBAR_HEADER_LEADING_ACTION_CLASS_NAME,
              "left-4",
              SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
              isPinned
                ? "pointer-events-auto opacity-100"
                : SIDEBAR_HEADER_LEADING_ACTION_REVEAL_CLASS_NAME,
            )}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void togglePin();
            }}
          >
            <PinStatusIcon pinned={isPinned} className="size-3.5" />
          </button>
        )}
        {offline ? null : (
          <SidebarSectionToolbar placement="overlay" revealOnHover>
            <SidebarIconButton
              icon={NewThreadIcon}
              label={`New thread in ${project.title} on ${host}`}
              tooltip={`New thread on ${host}`}
              tooltipSide="top"
              onClick={() => void startThread(hostId, host, projectId)}
            />
            <SidebarIconButton
              icon={TrashCanIcon}
              label={`Remove project ${project.title} on ${host}`}
              tooltip="Remove project"
              tooltipSide="top"
              className="hover:text-destructive"
              onClick={removeProject}
            />
          </SidebarSectionToolbar>
        )}
      </div>
      {menuPosition ? (
        <ProjectContextMenu
          position={menuPosition}
          onClose={() => setMenuPosition(null)}
          onAction={onAction}
          pinLabel={pinActionLabel("project", isPinned)}
        />
      ) : null}
      {dialog === "rename" ? (
        <RenameDialog
          open
          title="Edit project"
          description={`Renames the project on ${host}.`}
          initialValue={project.title}
          saveLabel="Save"
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          onSave={async (title) => {
            try {
              await renameHostProject(hostId, projectId, title);
            } catch (error) {
              fail(`Could not rename the project on ${host}`, error);
              throw error;
            }
          }}
        />
      ) : null}
      {dialog === "relocate" ? (
        <RelocateProjectDialog
          projectId={projectId}
          hostId={hostId}
          workspaceRoot={project.workspaceRoot}
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
        />
      ) : null}
      {projectOpen ? (
        <SidebarMenu className={cn(SIDEBAR_NESTED_LIST_GAP_CLASS_NAME, "pt-0.5")}>
          {project.threads.map((thread) => (
            <RemoteThreadRow
              key={thread.id}
              hostId={hostId}
              host={host}
              thread={thread}
              activeThreadParam={activeThreadParam}
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
          {catalog.projects.map((project) => (
            <RemoteProjectRow
              key={project.id}
              hostId={hostId}
              host={host}
              hostKey={hostKey}
              project={project}
              offline={offline}
              activeThreadParam={activeThreadParam}
              collapsed={collapsed}
            />
          ))}
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

/** A thread and its subagent sessions, which each list on their own in Activity. */
function withNestedThreads(thread: RemoteCatalogThread): RemoteCatalogThread[] {
  return [thread, ...thread.children.flatMap(withNestedThreads)];
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
    .flatMap((project) => project.threads.flatMap(withNestedThreads))
    .filter((thread) => thread.state !== "idle")
    .toSorted(
      (a, b) =>
        ACTIVITY_ORDER[a.state] - ACTIVITY_ORDER[b.state] || b.updatedAt.localeCompare(a.updatedAt),
    );
  return threads.map((thread) => (
    <RemoteThreadRow
      key={`${hostKey}:${thread.id}`}
      hostId={hostId}
      host={host}
      thread={thread}
      activeThreadParam={activeThreadParam}
      variant="pinned"
    />
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
