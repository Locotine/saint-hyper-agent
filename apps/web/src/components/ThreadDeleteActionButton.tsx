// FILE: ThreadDeleteActionButton.tsx
// Purpose: Hover-revealed delete action for thread rows on this computer and on remote hosts —
//          one icon, label, sizing, and row-activation guard, matching the archive action.
// Layer: Sidebar UI primitive
// Exports: ThreadDeleteActionButton

import { cn } from "~/lib/utils";
import { TrashCanIcon } from "~/lib/icons";
import { SIDEBAR_TRAILING_ICON_CLASS } from "./sidebarGlyphs";
import { SidebarIconButton } from "./SidebarIconButton";

export function ThreadDeleteActionButton({
  threadId,
  toneClassName,
  onDelete,
}: {
  threadId: string;
  toneClassName?: string;
  onDelete: () => void;
}) {
  return (
    <SidebarIconButton
      icon={TrashCanIcon}
      label="Delete thread"
      title="Delete thread"
      data-testid={`thread-delete-${threadId}`}
      size="md"
      iconClassName={SIDEBAR_TRAILING_ICON_CLASS}
      className={cn("hover:text-destructive", toneClassName)}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onDelete();
      }}
    />
  );
}
