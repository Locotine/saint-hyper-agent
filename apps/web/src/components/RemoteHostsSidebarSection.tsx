// FILE: RemoteHostsSidebarSection.tsx
// Purpose: Left-nav section listing remote SSH hosts with their projects and threads (read-only).
// Layer: Sidebar UI (desktop Beta; renders only while the remote SSH bridge reports hosts)
// Exports: RemoteHostsSidebarSection

import type { DesktopRemoteSshHostState, DesktopRemoteSshState } from "@saint/contracts";
import { useState } from "react";

import { useRemoteHostCatalog } from "~/hooks/useRemoteHostCatalog";
import { FolderIcon, ServerIcon } from "~/lib/icons";
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

/** Opens the host's window, the only place a remote thread runs until it can open here. */
function openHostWindow(state: DesktopRemoteSshState, host: string): void {
  const saved = state.savedHosts.find((entry) => entry.host === host);
  void window.desktopBridge?.remoteSsh
    ?.connect({ host, remoteRoot: saved?.remoteRoot ?? null })
    .catch(() => undefined);
}

function RemoteHostGroup(props: {
  state: DesktopRemoteSshState;
  host: string;
  hostState: DesktopRemoteSshHostState | null;
}) {
  const { state, host, hostState } = props;
  const [expanded, setExpanded] = useState(true);
  const status = remoteHostSidebarStatus(hostState);
  const connected = status === "connected";
  const catalog = useRemoteHostCatalog(host, connected ? (hostState?.localPort ?? null) : null);
  const statusLabel = remoteHostStatus(hostState);

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
                          onClick={() => openHostWindow(state, host)}
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
                      onClick={() => openHostWindow(state, host)}
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

export function RemoteHostsSidebarSection(props: { state: DesktopRemoteSshState }) {
  const rows = remoteHostRows(props.state);
  if (rows.length === 0) return null;
  return (
    <SidebarGroup className="px-1.5 pt-1 pb-2">
      <div className="my-1 flex h-7 items-center px-2 py-0.5">
        <span className={cn("truncate", SIDEBAR_SECTION_LABEL_CLASS_NAME)}>Remote hosts</span>
      </div>
      <SidebarMenu className="gap-1">
        {rows.map((row) => (
          <RemoteHostGroup
            key={row.host}
            state={props.state}
            host={row.host}
            hostState={row.state}
          />
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
