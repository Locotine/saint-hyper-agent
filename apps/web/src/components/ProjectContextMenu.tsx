// FILE: ProjectContextMenu.tsx
// Purpose: The sidebar's project right-click menu and the one-row thread menu, shared by this
//          computer's rows and a remote host's rows so every row opens the same popup.
// Layer: Sidebar UI
// Exports: ProjectContextMenu, ProjectContextMenuId, SidebarRowContextMenu

import { useMemo, type ReactNode } from "react";

import { createClientPointMenuAnchor } from "~/lib/clientPointMenuAnchor";
import {
  ArchiveIcon,
  CopyIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  KanbanIcon,
  PencilIcon,
  PinIcon,
  PlayIcon,
  StopFilledIcon,
  Trash2,
  XIcon,
} from "~/lib/icons";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import {
  SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME,
  SIDEBAR_CONTEXT_MENU_PANEL_CLASS_NAME,
  SidebarContextMenuIcon,
} from "./sidebarContextMenuStyles";
import { Menu, MenuGroup, MenuItem, MenuSeparator } from "./ui/menu";

export type ProjectContextMenuId =
  | "open-in-finder"
  | "open-in-kanban"
  | "copy-path"
  | "relocate"
  | "start-dev"
  | "stop-dev"
  | "open-dev-server"
  | "rename"
  | "edit-project-agent"
  | "toggle-pin-project-agent"
  | "toggle-pin"
  | "archive-threads"
  | "delete-threads"
  | "delete";

/** The popup every sidebar row's right-click opens: one chrome, anchored at the click. */
export function SidebarRowContextMenu(props: {
  position: { x: number; y: number };
  onClose: () => void;
  children: ReactNode;
}) {
  const { position, onClose } = props;
  const anchor = useMemo(() => createClientPointMenuAnchor(position), [position]);
  return (
    <Menu
      keepOpenOnSubmenuInteraction
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <ComposerPickerMenuPopup
        anchor={anchor}
        align="start"
        side="bottom"
        sideOffset={0}
        className={SIDEBAR_CONTEXT_MENU_PANEL_CLASS_NAME}
      >
        <MenuGroup>{props.children}</MenuGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

/** Rows only this computer's projects have: dev runs, spaces, coordinator, bulk thread actions. */
export interface LocalProjectMenuRows {
  readonly isRunning: boolean;
  readonly hasOpenServer: boolean;
  /** The "Move to space" submenu. */
  readonly moveToSpace: ReactNode;
  /** Edit coordinator and its pin, for group containers. */
  readonly coordinator: ReactNode;
  readonly hasArchivableThreads: boolean;
  readonly hasAnyThreads: boolean;
}

/**
 * A project's right-click menu. A remote host's project passes no `local` rows: its folder is
 * on another machine, so Finder, Kanban, dev runs and Spaces do not apply to it.
 */
export function ProjectContextMenu(props: {
  position: { x: number; y: number };
  onClose: () => void;
  onAction: (id: ProjectContextMenuId) => void;
  pinLabel: string;
  local?: LocalProjectMenuRows;
}) {
  const { local, onAction } = props;
  const row = (id: ProjectContextMenuId, icon: typeof PinIcon, label: string) => (
    <MenuItem className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME} onClick={() => onAction(id)}>
      <SidebarContextMenuIcon icon={icon} />
      <span>{label}</span>
    </MenuItem>
  );
  return (
    <SidebarRowContextMenu position={props.position} onClose={props.onClose}>
      {local ? row("open-in-finder", FolderOpenIcon, "Open in Finder") : null}
      {local ? row("open-in-kanban", KanbanIcon, "Open in Kanban") : null}
      {row("copy-path", CopyIcon, "Copy Path")}
      <MenuSeparator />
      {local ? (
        <>
          {local.isRunning
            ? row("stop-dev", StopFilledIcon, "Stop dev")
            : row("start-dev", PlayIcon, "Start dev")}
          {local.hasOpenServer ? row("open-dev-server", ExternalLinkIcon, "Open dev server") : null}
          {local.moveToSpace}
          <MenuSeparator />
        </>
      ) : null}
      {row("rename", PencilIcon, "Edit project")}
      {local?.coordinator}
      {row("relocate", FolderOpenIcon, "Change project path…")}
      {row("toggle-pin", PinIcon, props.pinLabel)}
      {local && (local.hasArchivableThreads || local.hasAnyThreads) ? <MenuSeparator /> : null}
      {local?.hasArchivableThreads ? row("archive-threads", ArchiveIcon, "Archive threads") : null}
      {local?.hasAnyThreads ? row("delete-threads", Trash2, "Delete threads") : null}
      <MenuSeparator />
      {row("delete", XIcon, "Remove")}
    </SidebarRowContextMenu>
  );
}
