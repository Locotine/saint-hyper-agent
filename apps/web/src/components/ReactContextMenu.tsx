// FILE: ReactContextMenu.tsx
// Purpose: Shows a list of ContextMenuItem rows in the app's own React menu popup and resolves
//          with the chosen id, the way `api.contextMenu.show` does for the native menu.
// Layer: Sidebar UI
// Exports: showReactContextMenu, ReactContextMenuHost
// Why: The thread menus build long, conditional item lists (handoff, fork, snooze, groups)
//      that other surfaces extend. Keeping their item model and swapping only the popup gives
//      them the project menu's look without rewriting every row as JSX.

import type { ContextMenuItem } from "@saint/contracts";
import { Fragment } from "react";
import { create } from "zustand";

import { CentralIcon } from "~/lib/central-icons";
import { isInlineSvgMenuIcon } from "~/lib/nativeMenuIcons";
import { ComposerPickerMenuSubPopup } from "./chat/ComposerPickerMenuPopup";
import { SidebarRowContextMenu } from "./ProjectContextMenu";
import {
  SIDEBAR_CONTEXT_MENU_ICON_CLASS_NAME,
  SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME,
} from "./sidebarContextMenuStyles";
import { MenuItem, MenuSeparator, MenuSub, MenuSubTrigger } from "./ui/menu";

interface OpenMenu {
  readonly items: readonly ContextMenuItem[];
  readonly position: { x: number; y: number };
  readonly resolve: (id: string | null) => void;
}

const useReactContextMenuStore = create<{ open: OpenMenu | null }>(() => ({ open: null }));

function settle(menu: OpenMenu, id: string | null) {
  // A menu replaced by a newer one has already resolved with null.
  if (useReactContextMenuStore.getState().open !== menu) return;
  useReactContextMenuStore.setState({ open: null });
  menu.resolve(id);
}

/** Same contract as `api.contextMenu.show`: the chosen leaf id, or null when dismissed. */
export function showReactContextMenu<T extends string>(
  items: readonly ContextMenuItem<T>[],
  position: { x: number; y: number } = { x: 0, y: 0 },
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const previous = useReactContextMenuStore.getState().open;
    if (previous) settle(previous, null);
    useReactContextMenuStore.setState({
      open: { items, position, resolve: resolve as (id: string | null) => void },
    });
  });
}

function MenuRowIcon({ icon }: { icon: string | undefined }) {
  if (!icon) return null;
  return (
    <span className={SIDEBAR_CONTEXT_MENU_ICON_CLASS_NAME}>
      {isInlineSvgMenuIcon(icon) ? (
        <span
          className="inline-flex size-3.5 [&>svg]:size-3.5"
          dangerouslySetInnerHTML={{ __html: icon }}
        />
      ) : (
        <CentralIcon name={icon} />
      )}
    </span>
  );
}

function MenuRows(props: { items: readonly ContextMenuItem[]; onPick: (id: string) => void }) {
  return props.items.map((item, index) => (
    <Fragment key={item.id}>
      {item.separatorBefore && index > 0 ? <MenuSeparator /> : null}
      {item.children ? (
        <MenuSub keepOpenOnFocusOut>
          <MenuSubTrigger className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}>
            <MenuRowIcon icon={item.icon} />
            <span>{item.label}</span>
          </MenuSubTrigger>
          <ComposerPickerMenuSubPopup className="min-w-48">
            <MenuRows items={item.children} onPick={props.onPick} />
          </ComposerPickerMenuSubPopup>
        </MenuSub>
      ) : (
        <MenuItem
          variant={item.destructive ? "destructive" : "default"}
          className={item.destructive ? undefined : SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}
          onClick={() => props.onPick(item.id)}
        >
          <MenuRowIcon icon={item.icon} />
          <span>{item.label}</span>
        </MenuItem>
      )}
    </Fragment>
  ));
}

/** Renders the menu `showReactContextMenu` opened; mount it once beside the sidebar. */
export function ReactContextMenuHost() {
  const open = useReactContextMenuStore((state) => state.open);
  if (!open) return null;
  return (
    <SidebarRowContextMenu
      position={open.position}
      onClose={() => settle(open, null)}
      className="min-w-48"
    >
      <MenuRows items={open.items} onPick={(id) => settle(open, id)} />
    </SidebarRowContextMenu>
  );
}
