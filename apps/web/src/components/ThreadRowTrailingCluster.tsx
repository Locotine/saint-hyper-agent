// FILE: ThreadRowTrailingCluster.tsx
// Purpose: The trailing end of a sidebar thread row (meta chips, jump shortcut, status glyph,
//          PR chip, hover actions), shared by this computer's rows and a remote host's rows.
// Layer: Sidebar UI primitive
// Exports: ThreadRowTrailingCluster

import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { sidebarHoverRevealHideClassName } from "~/sidebarRowStyles";
import { resolveThreadStatusTrailingIndicator, type ThreadStatusPill } from "./Sidebar.logic";
import { SidebarMetaChipStack } from "./SidebarMetaChip";
import { SidebarStatusTrailingGlyph } from "./SidebarStatusTrailingGlyph";
import { ShortcutKbd } from "./ui/kbd";

type ThreadMetaChip = ComponentProps<typeof SidebarMetaChipStack>["chips"][number];

/** Meta chips fade on row hover so pin/archive actions can occupy the same slot. */
const THREAD_ROW_META_CHIP_HOVER_FADE_CLASS_NAME = cn(
  "flex shrink-0 items-center",
  sidebarHoverRevealHideClassName("thread-row"),
);

/** Status glyph slot; matches the 15px meta-chip column so trailing icons stay compact. */
function threadRowStatusSlotClassName(toneClassName?: string): string {
  return cn(
    "flex w-[15px] shrink-0 items-center justify-center leading-none tabular-nums",
    sidebarHoverRevealHideClassName("thread-row"),
    // Nudge the timestamp a hair above the meta scale while still tracking the user's
    // typography setting (the CSS var is always set; the 11px is just an SSR fallback).
    "text-[length:calc(var(--app-font-size-ui-meta,11px)+0.5px)]",
    toneClassName ?? "text-muted-foreground/38",
  );
}

export function ThreadRowTrailingCluster(props: {
  threadJumpLabel: string | null;
  rightMetaChips: ThreadMetaChip[];
  prChip: ThreadMetaChip | null;
  threadStatus: ThreadStatusPill | null;
  timestampToneClassName?: string;
  hoverActions: ReactNode;
}) {
  // The jump shortcut owns the slot while it is visible; otherwise the shared
  // rule decides which status glyph shows here.
  const trailingStatus = resolveThreadStatusTrailingIndicator({
    status: props.threadStatus,
    slotOccupied: Boolean(props.threadJumpLabel),
  });
  return (
    <div className="relative flex min-w-0 items-center justify-end gap-2 group-hover/thread-row:min-w-19 group-focus-within/thread-row:min-w-19">
      {props.rightMetaChips.length > 0 ? (
        <div className={cn("shrink-0", THREAD_ROW_META_CHIP_HOVER_FADE_CLASS_NAME)}>
          <SidebarMetaChipStack chips={props.rightMetaChips} />
        </div>
      ) : null}
      {props.threadJumpLabel ? (
        <ShortcutKbd
          shortcutLabel={props.threadJumpLabel}
          title={props.threadJumpLabel}
          groupClassName={cn(THREAD_ROW_META_CHIP_HOVER_FADE_CLASS_NAME, "shrink")}
        />
      ) : null}
      {trailingStatus ? (
        // The relative time now lives in the row hover card, so the trailing
        // slot only carries the live status/loader glyph; when idle it
        // collapses and the hover action icons sit flush at the end.
        <span
          title={trailingStatus.label}
          className={threadRowStatusSlotClassName(props.timestampToneClassName)}
        >
          <SidebarStatusTrailingGlyph status={trailingStatus} />
        </span>
      ) : null}
      {props.prChip ? (
        <div className={cn("shrink-0", THREAD_ROW_META_CHIP_HOVER_FADE_CLASS_NAME)}>
          <SidebarMetaChipStack chips={[props.prChip]} />
        </div>
      ) : null}
      {props.hoverActions}
    </div>
  );
}
