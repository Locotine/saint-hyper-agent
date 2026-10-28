// FILE: RemoteHostsSidebarSection.tsx
// Purpose: Left-nav section listing remote SSH hosts with their projects and threads; choosing
//          one switches this window onto that host, and "This computer" switches back.
// Layer: Sidebar UI (desktop Beta; renders only while the remote SSH bridge reports hosts)
// Exports: RemoteHostsSidebarSection

import type { DesktopRemoteSshHostState, DesktopRemoteSshState } from "@saint/contracts";
import { useState } from "react";

import { toastManager } from "~/components/ui/toast";
import { useRemoteHostCatalog } from "~/hooks/useRemoteHostCatalog";
import { FolderIcon, MonitorIcon, ServerIcon } from "~/lib/icons";
import { rememberPendingRemoteThread } from "~/lib/pendingRemoteThread";
import { cn } from "~/lib/utils";
import {
  remoteHostSidebarStatus,
  type RemoteCatalogThreadState,
  type RemoteHostSidebarStatus,
} from "~/lib/remoteHostCatalog";
import {
  DISCLOSURE_INNER_CLASS,
  disclosureContentClassName,
  disclosureShellClassName,
} from "~/lib/disclosureMotion";
import {
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
  SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
  SIDEBAR_SECTION_LABEL_CLASS_NAME,
  SIDEBAR_THREAD_ROW_BASE_CLASS_NAME,
} from "~/sidebarRowStyles";
import { remoteHostRows, remoteHostStatus } from "./settings/remoteHostsSettingsModel";
import { DisclosureChevron } from "./ui/DisclosureChevron";
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar";
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

/**
 * Switches this window to a host (or back to this computer with null). The window
 * reloads onto that backend; a chosen thread opens once it is up.
 */
function switchBackend(host: string | null, threadId?: string): void {
  if (host !== null && threadId) rememberPendingRemoteThread(host, threadId);
  void window.desktopBridge?.remoteSsh?.activate(host).catch((error: unknown) => {
    toastManager.add({
      type: "error",
      title: host === null ? "Could not switch to this computer" : `Could not open ${host}`,
      description: error instanceof Error ? error.message : String(error),
    });
  });
}

function RemoteHostGroup(props: {
  host: string;
  hostState: DesktopRemoteSshHostState | null;
  /** This window already runs on the host: its projects are the main list. */
  isActive: boolean;
}) {
  const { host, hostState, isActive } = props;
  const [expanded, setExpanded] = useState(true);
  const status = remoteHostSidebarStatus(hostState);
  const connected = status === "connected" && !isActive;
  const catalog = useRemoteHostCatalog(
    host,
    connected ? (hostState?.localPort ?? null) : null,
    hostState ? { hostKey: hostState.hostKey, epoch: hostState.epoch } : undefined,
  );
  const statusLabel = isActive ? "Active in this window" : remoteHostStatus(hostState);

  return (
    <SidebarMenuItem className="rounded-md">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              size="sm"
              aria-expanded={connected ? expanded : undefined}
              className={cn(
                SIDEBAR_HEADER_ROW_CLASS_NAME,
                SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
                SIDEBAR_ROW_HOVER_CLASS_NAME,
              )}
              onClick={() => connected && setExpanded((current) => !current)}
            />
          }
        >
          <ServerIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/79" />
          <span className="min-w-0 flex-1 truncate">{host}</span>
          {isActive ? <span className="text-ui-xs text-muted-foreground/79">Active</span> : null}
          <StatusDot className={STATUS_DOT_CLASS_NAME[status]} />
          {connected ? <DisclosureChevron open={expanded} /> : null}
        </TooltipTrigger>
        <TooltipPopup side="right">{`Remote host ${host} · ${statusLabel}`}</TooltipPopup>
      </Tooltip>

      {connected ? (
        <div className={cn(disclosureShellClassName(expanded), "pt-0.5")}>
          <div className={DISCLOSURE_INNER_CLASS}>
            <SidebarMenu
              className={cn(
                SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
                disclosureContentClassName(expanded),
              )}
            >
              {catalog.status === "loading" ? (
                <div className="px-2 py-1 pl-8 text-ui-sm text-muted-foreground/58">Loading…</div>
              ) : null}
              {catalog.status === "error" && catalog.projects.length === 0 ? (
                <div className="px-2 py-1 pl-8 text-ui-sm text-destructive">
                  {catalog.message ?? "Could not read this host."}
                </div>
              ) : null}
              {catalog.status === "ready" && catalog.projects.length === 0 ? (
                <div className="px-2 py-1 pl-8 text-ui-sm text-muted-foreground/58">
                  No projects on this host
                </div>
              ) : null}
              {catalog.projects.map((project) => (
                <SidebarMenuItem key={project.id}>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <SidebarMenuButton
                          size="sm"
                          className={cn(
                            SIDEBAR_THREAD_ROW_BASE_CLASS_NAME,
                            "gap-1.5 pl-5",
                            SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
                            SIDEBAR_ROW_HOVER_CLASS_NAME,
                          )}
                          onClick={() => switchBackend(host)}
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
                  {project.threads.map((thread) => (
                    <SidebarMenuButton
                      key={thread.id}
                      size="sm"
                      className={cn(
                        SIDEBAR_THREAD_ROW_BASE_CLASS_NAME,
                        "gap-1.5 pl-9",
                        SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
                        SIDEBAR_ROW_HOVER_CLASS_NAME,
                      )}
                      onClick={() => switchBackend(host, thread.id)}
                    >
                      <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                      <StatusDot className={THREAD_DOT_CLASS_NAME[thread.state]} />
                    </SidebarMenuButton>
                  ))}
                  {project.hiddenThreadCount > 0 ? (
                    <div className="px-2 py-1 pl-9 text-ui-sm text-muted-foreground/58">
                      {`+${project.hiddenThreadCount} more on ${host}`}
                    </div>
                  ) : null}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </div>
        </div>
      ) : null}
    </SidebarMenuItem>
  );
}

/** `activeHost` is the host this window already runs on, null when it runs on this computer. */
export function RemoteHostsSidebarSection(props: {
  state: DesktopRemoteSshState;
  activeHost: string | null;
}) {
  const rows = remoteHostRows(props.state);
  if (rows.length === 0) return null;
  return (
    <SidebarGroup className="px-1.5 pt-1 pb-2">
      <div className="my-1 flex h-7 items-center px-2 py-0.5">
        <span className={cn("truncate", SIDEBAR_SECTION_LABEL_CLASS_NAME)}>Remote hosts</span>
      </div>
      <SidebarMenu className="gap-1">
        {props.activeHost ? (
          <SidebarMenuItem className="rounded-md">
            <SidebarMenuButton
              size="sm"
              className={cn(
                SIDEBAR_HEADER_ROW_CLASS_NAME,
                SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
                SIDEBAR_ROW_HOVER_CLASS_NAME,
              )}
              onClick={() => switchBackend(null)}
            >
              <MonitorIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/79" />
              <span className="min-w-0 flex-1 truncate">This computer</span>
              <span className="text-ui-xs text-muted-foreground/79">Local</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
        {rows.map((row) => (
          <RemoteHostGroup
            key={row.host}
            host={row.host}
            hostState={row.state}
            isActive={row.host === props.activeHost}
          />
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
