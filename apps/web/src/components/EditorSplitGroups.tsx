// FILE: EditorSplitGroups.tsx
// Purpose: VS Code-style split editor groups: drag a file tab onto a group's tab
//          strip to move it, or onto an edge of a group to split; dividers resize.
//          Shared by the editor workspace and the dock explorer.
// Layer: Editor UI components
// Exports: EditorSplitGroups, FilePreviewTabs, extractDroppedFilePath

import {
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  type Dispatch,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SetStateAction,
  Fragment,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import {
  dropFileOnSplitZone,
  type EditorSplitDropZone,
  type EditorSplitGroup,
  type EditorSplitLayoutState,
  moveTabBetweenSplitGroups,
  resizeSplitGroups,
  resolveSplitDropZoneFromPoint,
  selectFileInSplitGroup,
} from "~/editorViewState";
import { CHAT_FILE_REFERENCE_DRAG_TYPE } from "~/lib/chatReferences";
import { cn } from "~/lib/utils";
import { CSS } from "@dnd-kit/utilities";
import { XIcon } from "~/lib/icons";
import { useHorizontalWheelScroll } from "./chat/chatHeaderControls";
import { setFileReferenceDragData } from "./chat/workspaceExplorer";
import {
  WORKSPACE_TAB_ACTIVE_CLASS_NAME,
  WORKSPACE_TAB_CLASS_NAME,
  WORKSPACE_TAB_IDLE_CLASS_NAME,
} from "./TerminalWorkspaceTabs";
import { IconButton } from "./ui/icon-button";

function FilePreviewTabItem(props: {
  groupId: string | undefined;
  path: string;
  active: boolean;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}) {
  const { groupId, path, active } = props;
  const name = path.split("/").pop() ?? path;
  const draggable = useDraggable({
    id: groupId ? `editor-tab:${groupId}:${path}` : `dock-tab:${path}`,
    disabled: !groupId,
    data: {
      kind: "editor-file-tab",
      groupId: groupId ?? "group-1",
      filePath: path,
    },
  });
  const style = draggable.transform
    ? { transform: CSS.Translate.toString(draggable.transform) }
    : undefined;
  const handleNativeDragStart = (event: ReactDragEvent<HTMLDivElement>) => {
    setFileReferenceDragData(event.dataTransfer, path);
    if (groupId) {
      event.dataTransfer.setData("application/x-saint-editor-group", groupId);
    }
  };
  return (
    <div
      ref={groupId ? draggable.setNodeRef : undefined}
      style={style}
      {...(groupId ? draggable.listeners : undefined)}
      {...(groupId ? draggable.attributes : undefined)}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      draggable
      onDragStart={handleNativeDragStart}
      className={cn(
        WORKSPACE_TAB_CLASS_NAME,
        "max-w-48 cursor-default gap-1 pr-1",
        active ? WORKSPACE_TAB_ACTIVE_CLASS_NAME : WORKSPACE_TAB_IDLE_CLASS_NAME,
        draggable.isDragging && "opacity-60",
      )}
      onClick={() => props.onSelect(path)}
      onAuxClick={(event) => {
        if (event.button === 1) props.onClose(path);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") props.onSelect(path);
      }}
    >
      <span className="min-w-0 truncate">{name}</span>
      <IconButton
        label={`Close ${name}`}
        tooltip="Close preview"
        size="icon-xs"
        variant="chrome"
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          props.onClose(path);
        }}
      >
        <XIcon className="size-3" />
      </IconButton>
    </div>
  );
}

/** One tab per open file; the X closes it, and closing the last one closes the preview. */
export function FilePreviewTabs(props: {
  groupId?: string | undefined;
  openFilePaths: readonly string[];
  selectedFilePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  useHorizontalWheelScroll(stripRef);
  const droppable = useDroppable({
    id: props.groupId ? `editor-group-tabs:${props.groupId}` : "dock-group-tabs",
    disabled: !props.groupId,
    data: {
      kind: "editor-group-tabs",
      groupId: props.groupId ?? "group-1",
    },
  });
  return (
    <div
      ref={props.groupId ? droppable.setNodeRef : undefined}
      className={cn(
        "relative shrink-0 border-b border-border/70 bg-muted/10 px-2",
        droppable.isOver && "bg-accent/25",
      )}
    >
      <div
        ref={stripRef}
        role="tablist"
        aria-label="Open files"
        className="flex min-w-0 items-end gap-1 overflow-x-auto overflow-y-hidden overscroll-contain pt-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {props.openFilePaths.map((path) => (
          <FilePreviewTabItem
            key={path}
            groupId={props.groupId}
            path={path}
            active={path === props.selectedFilePath}
            onSelect={props.onSelect}
            onClose={props.onClose}
          />
        ))}
      </div>
    </div>
  );
}

const SPLIT_DROP_ZONES: ReadonlyArray<EditorSplitDropZone> = [
  "left",
  "right",
  "top",
  "bottom",
  "center",
];

const SPLIT_ZONE_HITBOX_CLASS: Record<EditorSplitDropZone, string> = {
  left: "inset-y-0 left-0 w-1/4 z-20",
  right: "inset-y-0 right-0 w-1/4 z-20",
  top: "inset-x-1/4 top-0 h-1/4 z-20",
  bottom: "inset-x-1/4 bottom-0 h-1/4 z-20",
  center: "inset-1/4 z-10",
};

const SPLIT_ZONE_HIGHLIGHT_CLASS: Record<EditorSplitDropZone, string> = {
  left: "inset-y-1 left-1 w-[calc(50%-0.25rem)]",
  right: "inset-y-1 right-1 w-[calc(50%-0.25rem)]",
  top: "inset-x-1 top-1 h-[calc(50%-0.25rem)]",
  bottom: "inset-x-1 bottom-1 h-[calc(50%-0.25rem)]",
  center: "inset-1",
};

function SplitZoneDroppableTarget(props: {
  groupId: string;
  zone: EditorSplitDropZone;
  active: boolean;
  onHoverZone: (zone: EditorSplitDropZone | null) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `editor-split-zone:${props.groupId}:${props.zone}`,
    data: {
      kind: "editor-split-zone",
      groupId: props.groupId,
      zone: props.zone,
    },
  });

  const handleHover = useEffectEvent(() => {
    props.onHoverZone(props.zone);
  });

  useEffect(() => {
    if (isOver) {
      handleHover();
    }
  }, [isOver]);

  if (!props.active) return null;
  return (
    <div
      ref={setNodeRef}
      data-split-drop-zone={`${props.groupId}:${props.zone}`}
      className={cn(" absolute", SPLIT_ZONE_HITBOX_CLASS[props.zone])}
    />
  );
}

export function extractDroppedFilePath(dataTransfer: DataTransfer): string | null {
  if (!Array.from(dataTransfer.types).includes(CHAT_FILE_REFERENCE_DRAG_TYPE)) {
    return null;
  }
  const plain = dataTransfer.getData("text/plain")?.trim();
  if (plain) return plain;
  return null;
}

export function EditorSplitGroups(props: {
  layout: EditorSplitLayoutState;
  setLayout: Dispatch<SetStateAction<EditorSplitLayoutState>>;
  /** Runs after a tab is selected, moved or dropped; the parent opens the file. */
  onActivateFile: (filePath: string) => void;
  onCloseTab: (groupId: string, filePath: string) => void;
  renderGroupBody: (group: EditorSplitGroup) => ReactNode;
}) {
  const { layout: splitLayout, setLayout: setSplitLayout } = props;
  const guardedSelectFile = props.onActivateFile;
  const handleCloseTabInGroup = props.onCloseTab;
  const splitDividerCleanupRef = useRef<(() => void) | null>(null);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const [dndActiveTab, setDndActiveTab] = useState<{
    groupId: string;
    filePath: string;
  } | null>(null);
  const [hoveredDropZone, setHoveredDropZone] = useState<{
    groupId: string;
    zone: EditorSplitDropZone;
  } | null>(null);

  useEffect(() => {
    return () => {
      splitDividerCleanupRef.current?.();
    };
  }, []);

  const dndSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  );

  const handleDndDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current as
      | { kind?: string; groupId?: string; filePath?: string }
      | undefined;
    if (data?.kind === "editor-file-tab" && data.groupId && data.filePath) {
      setDndActiveTab({ groupId: data.groupId, filePath: data.filePath });
    }
  };

  const handleDndDragEnd = (event: DragEndEvent) => {
    const source = dndActiveTab;
    setDndActiveTab(null);
    setHoveredDropZone(null);
    if (!source || !event.over) return;
    const overData = event.over.data.current as
      | { kind?: string; groupId?: string; zone?: EditorSplitDropZone }
      | undefined;
    if (!overData?.groupId) return;
    if (overData.kind === "editor-group-tabs") {
      setSplitLayout((current) =>
        moveTabBetweenSplitGroups(current, source.groupId, source.filePath, overData.groupId!),
      );
      guardedSelectFile(source.filePath);
      return;
    }
    if (overData.kind === "editor-split-zone" && overData.zone) {
      setSplitLayout((current) =>
        dropFileOnSplitZone(
          current,
          overData.groupId!,
          overData.zone!,
          source.filePath,
          source.groupId,
        ),
      );
      guardedSelectFile(source.filePath);
    }
  };

  const handleSelectTabInGroup = (groupId: string, filePath: string) => {
    setSplitLayout((current) => selectFileInSplitGroup(current, groupId, filePath));
    guardedSelectFile(filePath);
  };

  const handleSplitDividerPointerDown = (
    dividerIndex: number,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0 || typeof window === "undefined") return;
    const container = splitContainerRef.current;
    if (!container) return;
    event.preventDefault();
    event.stopPropagation();

    const rect = container.getBoundingClientRect();
    const isHorizontal = splitLayout.direction === "horizontal";
    const totalPixels = isHorizontal ? rect.width : rect.height;
    if (totalPixels <= 0) return;

    splitDividerCleanupRef.current?.();

    let lastPos = isHorizontal ? event.clientX : event.clientY;
    const pointerId = event.pointerId;
    const restoreCursor = document.body.style.cursor;
    const restoreUserSelect = document.body.style.userSelect;
    document.body.style.cursor = isHorizontal ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      document.body.style.cursor = restoreCursor;
      document.body.style.userSelect = restoreUserSelect;
      if (splitDividerCleanupRef.current === cleanup) {
        splitDividerCleanupRef.current = null;
      }
    };

    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const currentPos = isHorizontal ? moveEvent.clientX : moveEvent.clientY;
      const deltaPixels = currentPos - lastPos;
      lastPos = currentPos;
      const deltaPercent = (deltaPixels / totalPixels) * 100;
      setSplitLayout((current) => resizeSplitGroups(current, dividerIndex, deltaPercent));
    };

    const onEnd = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      cleanup();
    };

    splitDividerCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  const handleSplitDividerKeyDown = (
    dividerIndex: number,
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    const step = 5;
    let delta: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      delta = -step;
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      delta = step;
    }
    if (delta === null) return;
    event.preventDefault();
    setSplitLayout((current) => resizeSplitGroups(current, dividerIndex, delta));
  };
  return (
    <DndContext
      sensors={dndSensors}
      onDragStart={handleDndDragStart}
      onDragEnd={handleDndDragEnd}
      onDragCancel={() => {
        setDndActiveTab(null);
        setHoveredDropZone(null);
      }}
    >
      <div
        ref={splitContainerRef}
        data-editor-split-root
        data-split-direction={splitLayout.direction}
        className={cn(
          "flex min-h-0 min-w-0 flex-1 overflow-hidden",
          splitLayout.direction === "vertical" ? "flex-col" : "flex-row",
        )}
      >
        {splitLayout.groups.map((group: EditorSplitGroup, groupIndex: number) => {
          const isPrimaryActive = group.id === splitLayout.activeGroupId;
          const groupFilePath = group.selectedFilePath;
          const groupSizePercent = splitLayout.sizes[groupIndex] ?? 100 / splitLayout.groups.length;
          const activeZoneForGroup =
            hoveredDropZone?.groupId === group.id ? hoveredDropZone.zone : null;
          const handleGroupDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
            const types = Array.from(event.dataTransfer.types);
            if (!types.includes(CHAT_FILE_REFERENCE_DRAG_TYPE)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            const rect = event.currentTarget.getBoundingClientRect();
            const zone = resolveSplitDropZoneFromPoint(rect, event.clientX, event.clientY);
            setHoveredDropZone((previous) =>
              previous?.groupId === group.id && previous.zone === zone
                ? previous
                : { groupId: group.id, zone },
            );
          };
          const handleGroupDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
            if (
              event.relatedTarget instanceof Node &&
              event.currentTarget.contains(event.relatedTarget)
            ) {
              return;
            }
            setHoveredDropZone((previous) => (previous?.groupId === group.id ? null : previous));
          };
          const handleGroupDrop = (event: ReactDragEvent<HTMLDivElement>) => {
            const droppedPath = extractDroppedFilePath(event.dataTransfer);
            const sourceGroup =
              event.dataTransfer.getData("application/x-saint-editor-group") || null;
            setHoveredDropZone(null);
            if (!droppedPath) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            const zone = resolveSplitDropZoneFromPoint(rect, event.clientX, event.clientY);
            setSplitLayout((current) =>
              dropFileOnSplitZone(current, group.id, zone, droppedPath, sourceGroup),
            );
            guardedSelectFile(droppedPath);
          };

          return (
            <Fragment key={group.id}>
              <div
                data-editor-split-group={group.id}
                data-active-group={isPrimaryActive ? "true" : "false"}
                style={{ flexBasis: `${groupSizePercent}%` }}
                className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                onPointerDown={() => {
                  if (!isPrimaryActive) {
                    setSplitLayout((current) => ({
                      ...current,
                      activeGroupId: group.id,
                    }));
                  }
                }}
                onDragOver={handleGroupDragOver}
                onDragLeave={handleGroupDragLeave}
                onDrop={handleGroupDrop}
              >
                {group.openFilePaths.length > 0 ? (
                  <FilePreviewTabs
                    groupId={group.id}
                    openFilePaths={group.openFilePaths}
                    selectedFilePath={groupFilePath}
                    onSelect={(path) => handleSelectTabInGroup(group.id, path)}
                    onClose={(path) => handleCloseTabInGroup(group.id, path)}
                  />
                ) : null}
                <div className="relative flex min-h-0 min-w-0 flex-1">
                  {SPLIT_DROP_ZONES.map((zone) => (
                    <SplitZoneDroppableTarget
                      key={zone}
                      groupId={group.id}
                      zone={zone}
                      active={dndActiveTab !== null}
                      onHoverZone={(hovered) => {
                        if (hovered) {
                          setHoveredDropZone((previous) =>
                            previous?.groupId === group.id && previous.zone === hovered
                              ? previous
                              : { groupId: group.id, zone: hovered },
                          );
                        }
                      }}
                    />
                  ))}
                  {activeZoneForGroup ? (
                    <div
                      data-split-drop-overlay={activeZoneForGroup}
                      aria-hidden="true"
                      className={cn(
                        "pointer-events-none absolute z-30 rounded-md border-2 border-primary/70 bg-primary/15 transition-all",
                        SPLIT_ZONE_HIGHLIGHT_CLASS[activeZoneForGroup],
                      )}
                    />
                  ) : null}
                  {props.renderGroupBody(group)}
                </div>
              </div>
              {groupIndex < splitLayout.groups.length - 1 ? (
                <div
                  role="separator"
                  data-split-divider={groupIndex}
                  aria-label="Resize split editor group"
                  aria-orientation={
                    splitLayout.direction === "horizontal" ? "vertical" : "horizontal"
                  }
                  tabIndex={0}
                  className={cn(
                    "group relative z-20 shrink-0 bg-[var(--app-surface-divider)] outline-none transition-colors hover:bg-[var(--color-text-accent)] focus-visible:bg-[var(--color-text-accent)]",
                    splitLayout.direction === "horizontal"
                      ? "w-px cursor-col-resize"
                      : "h-px cursor-row-resize",
                  )}
                  onPointerDown={(event) => handleSplitDividerPointerDown(groupIndex, event)}
                  onKeyDown={(event) => handleSplitDividerKeyDown(groupIndex, event)}
                />
              ) : null}
            </Fragment>
          );
        })}
      </div>
    </DndContext>
  );
}
