// FILE: SidebarNestedThreads.tsx
// Purpose: A parent thread's subagent sessions under its row: a chevron on the row opens and
//          closes them, and while closed one line sums them up ("4 nested sessions · 3 failed").
//          Shared by this computer's thread rows and a remote host's.
// Layer: Sidebar UI
// Exports: NestedThreadsToggle, SidebarNestedThreads, useNestedThreadsOpen

import type { ReactNode } from "react";

import { TriangleAlertIcon } from "~/lib/icons";
import { nestedThreadsSummaryLabel } from "~/lib/nestedThreads";
import { cn } from "~/lib/utils";
import { useNestedThreadsStore } from "~/nestedThreadsStore";
import { DisclosureChevron } from "./ui/DisclosureChevron";
import { DisclosureRegion } from "./ui/DisclosureRegion";
import { SidebarMenuSubItem } from "./ui/sidebar";

/** Whether a parent's nested sessions are open, and the toggle that flips it. */
export function useNestedThreadsOpen(scopedThreadId: string) {
  const open = useNestedThreadsStore((store) => store.openThreadIds.includes(scopedThreadId));
  return {
    open,
    toggle: () => useNestedThreadsStore.getState().toggleNestedThreads(scopedThreadId),
  };
}

/** The chevron that sits after a parent row's title. */
export function NestedThreadsToggle(props: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={props.open}
      aria-label={props.open ? "Hide nested sessions" : "Show nested sessions"}
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/60 hover:text-foreground"
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        props.onToggle();
      }}
    >
      <DisclosureChevron open={props.open} className="size-3" />
    </button>
  );
}

/** The line(s) below a parent row. `children` are the nested rows, mounted only while open. */
export function SidebarNestedThreads(props: {
  open: boolean;
  summary: { readonly count: number; readonly failed: number };
  onToggle: () => void;
  children: ReactNode;
}) {
  const { open, summary } = props;
  return (
    <SidebarMenuSubItem className="w-full">
      <DisclosureRegion open={!open}>
        <button
          type="button"
          className="flex h-6 w-full min-w-0 items-center gap-1.5 rounded-md pr-2 pl-8 text-left text-ui-sm text-muted-foreground/58 hover:text-foreground"
          onClick={props.onToggle}
        >
          <span className="min-w-0 truncate">{nestedThreadsSummaryLabel(summary)}</span>
          {summary.failed > 0 ? (
            <TriangleAlertIcon aria-hidden className="ml-auto size-3 shrink-0 text-warning" />
          ) : null}
        </button>
      </DisclosureRegion>
      <DisclosureRegion open={open}>
        <ul className={cn("ml-5 flex flex-col gap-0.5 border-l border-border/40 pl-1.5")}>
          {open ? props.children : null}
        </ul>
      </DisclosureRegion>
    </SidebarMenuSubItem>
  );
}
