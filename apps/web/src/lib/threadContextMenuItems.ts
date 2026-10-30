// FILE: threadContextMenuItems.ts
// Purpose: The rows of a thread's right-click menu, shared by this computer's threads and a
//          remote host's so both lists offer the same actions in the same order.
// Layer: web UI utility
// Exports: buildThreadContextMenuItems

import type { ContextMenuItem } from "@saint/contracts";

import { contextMenuGroup } from "./contextMenuGroup";
import { THREAD_CONTEXT_MENU_ICONS } from "./contextMenuIcons";
import { pinActionLabel } from "./pin";
import { FORK_THREAD_TARGET_LABELS } from "./threadFork";
import type { ThreadHandoffTarget } from "./threadHandoff";
import { SNOOZE_PRESETS } from "./threadSnooze";

export function buildThreadContextMenuItems(input: {
  isPinned: boolean;
  /** The row carries a notification the menu can clear. */
  hasDismissibleNotification: boolean;
  canSnooze: boolean;
  isSnoozed: boolean;
  /** Same-thread handoff targets (a subset of `handoffTargets`' providers). */
  continueHandoffTargets: readonly ThreadHandoffTarget[];
  /** New-thread handoff targets. */
  handoffTargets: readonly ThreadHandoffTarget[];
  /** Fresh-from-transcript handoff targets, the source agent included. */
  transcriptHandoffTargets: readonly ThreadHandoffTarget[];
  canFork: boolean;
  hasWorkspacePath: boolean;
  /** Rows the calling surface adds (a tab's close actions). */
  extraItems: readonly ContextMenuItem[];
  /** The Hub group; empty where hubs do not apply. */
  hubItems: readonly ContextMenuItem[];
  /** Subagent threads are archived through their parent. */
  isSubagent: boolean;
}): ContextMenuItem[] {
  const { continueHandoffTargets, handoffTargets, transcriptHandoffTargets } = input;
  const handoffItems = contextMenuGroup(
    { id: "handoff", label: "Handoff", icon: THREAD_CONTEXT_MENU_ICONS.handoff },
    [
      ...continueHandoffTargets.map((target) => ({
        id: `handoff-here:${target.instanceId}`,
        label: `${target.label} in this thread`,
        standaloneLabel: `Handoff to ${target.label} in this thread`,
        icon: THREAD_CONTEXT_MENU_ICONS.handoff,
      })),
      ...handoffTargets.map((target, index) => ({
        id: `handoff:${target.instanceId}`,
        label: continueHandoffTargets.length > 0 ? `${target.label} in a new thread` : target.label,
        standaloneLabel: `Handoff to ${target.label}`,
        icon: THREAD_CONTEXT_MENU_ICONS.handoff,
        ...(index === 0 && continueHandoffTargets.length > 0 ? { separatorBefore: true } : {}),
      })),
      // Orca-style: a fresh session that reads the source transcript.
      ...transcriptHandoffTargets.map((target, index) => ({
        id: `handoff-transcript:${target.instanceId}`,
        label: `${target.label}, fresh from transcript`,
        standaloneLabel: `Handoff to ${target.label}, fresh from transcript`,
        icon: THREAD_CONTEXT_MENU_ICONS.handoff,
        ...(index === 0 && handoffTargets.length + continueHandoffTargets.length > 0
          ? { separatorBefore: true }
          : {}),
      })),
    ],
  );
  // Same action as `/fork`.
  const forkItems = input.canFork
    ? contextMenuGroup({ id: "fork", label: "Fork", icon: THREAD_CONTEXT_MENU_ICONS.fork }, [
        {
          id: "fork:local",
          label: FORK_THREAD_TARGET_LABELS.local,
          icon: THREAD_CONTEXT_MENU_ICONS.forkLocal,
        },
        {
          id: "fork:worktree",
          label: FORK_THREAD_TARGET_LABELS.worktree,
          icon: THREAD_CONTEXT_MENU_ICONS.forkWorktree,
        },
      ])
    : [];
  if (forkItems[0] && handoffItems.length === 0) {
    forkItems[0] = { ...forkItems[0], separatorBefore: true };
  }
  if (handoffItems[0]) {
    handoffItems[0] = { ...handoffItems[0], separatorBefore: true };
  }
  return [
    { id: "rename", label: "Rename thread", icon: THREAD_CONTEXT_MENU_ICONS.rename },
    {
      id: "toggle-pin",
      label: pinActionLabel("thread", input.isPinned),
      icon: THREAD_CONTEXT_MENU_ICONS.pin,
    },
    ...(input.hasDismissibleNotification
      ? [
          {
            id: "clear-notification",
            label: "Clear notification",
            icon: THREAD_CONTEXT_MENU_ICONS.clearNotification,
          },
        ]
      : []),
    { id: "mark-unread", label: "Mark unread", icon: THREAD_CONTEXT_MENU_ICONS.markUnread },
    ...(input.canSnooze
      ? [
          ...(input.isSnoozed
            ? [
                {
                  id: "snooze-cancel",
                  label: "Return now",
                  icon: THREAD_CONTEXT_MENU_ICONS.snooze,
                  separatorBefore: true,
                },
              ]
            : []),
          ...contextMenuGroup(
            {
              id: "snooze",
              label: input.isSnoozed ? "Reschedule" : "Snooze",
              icon: THREAD_CONTEXT_MENU_ICONS.snooze,
              separatorBefore: !input.isSnoozed,
            },
            [
              ...SNOOZE_PRESETS.map((preset) => ({
                id: preset.id,
                label: preset.label,
                icon: THREAD_CONTEXT_MENU_ICONS.snooze,
              })),
              {
                id: "snooze-custom",
                label: "Pick date & time…",
                icon: THREAD_CONTEXT_MENU_ICONS.snooze,
              },
            ],
          ),
        ]
      : []),
    ...handoffItems,
    ...forkItems,
    ...contextMenuGroup(
      {
        id: "copy",
        label: "Copy",
        icon: THREAD_CONTEXT_MENU_ICONS.copy,
        separatorBefore: true,
      },
      [
        {
          id: "copy-path",
          label: "Path",
          standaloneLabel: "Copy Path",
          icon: THREAD_CONTEXT_MENU_ICONS.copy,
        },
        {
          id: "copy-thread-id",
          label: "Thread ID",
          standaloneLabel: "Copy Thread ID",
          icon: THREAD_CONTEXT_MENU_ICONS.copy,
        },
      ],
    ),
    ...(input.hasWorkspacePath
      ? [
          {
            id: "open-path-in-terminal",
            label: "Open Path in Terminal",
            icon: THREAD_CONTEXT_MENU_ICONS.openInTerminal,
          },
        ]
      : []),
    ...input.extraItems,
    ...input.hubItems,
    // Subagent threads are archived and restored through their parent
    // (thread.archive cascades); archiving one alone would strand it with
    // no sidebar or Archived-panel row to restore it from.
    ...(input.isSubagent
      ? []
      : [
          {
            id: "archive",
            label: "Archive",
            icon: THREAD_CONTEXT_MENU_ICONS.archive,
            separatorBefore: true,
          },
        ]),
    {
      id: "delete",
      label: "Delete",
      icon: THREAD_CONTEXT_MENU_ICONS.delete,
      destructive: true,
      ...(input.isSubagent ? { separatorBefore: true } : {}),
    },
  ];
}
