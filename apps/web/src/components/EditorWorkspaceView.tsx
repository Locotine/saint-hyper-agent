// FILE: EditorWorkspaceView.tsx
// Purpose: Native editing surface with file explorer, workspace text search,
//          file/diff editing and previews, and chat.
// Layer: Chat route presentation

import {
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  WorkspaceFileOpenerContext,
  resolveWorkspaceFileOpenTarget,
} from "~/lib/workspaceFileOpener";
import type { ProjectId } from "@saint/contracts";
import type { FileDiffMetadata } from "@pierre/diffs/react";
import {
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  Fragment,
  useCallback,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import {
  ChangesIcon,
  ChatBubbleIcon,
  ChevronDownIcon,
  DiffIcon,
  FoldersIcon,
  PanelLeftIcon,
  PanelRightCloseIcon,
  SearchIcon,
} from "~/lib/icons";
import {
  closeFileInSplitGroup,
  createInitialEditorSplitLayout,
  dropFileOnSplitZone,
  type EditorSplitDropZone,
  type EditorSplitGroup,
  type EditorSplitLayoutState,
  moveTabBetweenSplitGroups,
  readEditorViewState,
  resizeSplitGroups,
  resolveSplitDropZoneFromPoint,
  selectFileInSplitGroup,
  storeEditorSplitLayout,
  syncPrimaryFileIntoSplitLayout,
} from "~/editorViewState";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import {
  buildFileDiffRenderKey,
  resolveFileDiffPath,
  splitRepoRelativePath,
  summarizeFileDiffStats,
} from "~/lib/diffRendering";
import { showFileReferenceContextMenu } from "~/lib/fileReferenceContextMenu";
import { CHAT_FILE_REFERENCE_DRAG_TYPE, type ChatFileReference } from "~/lib/chatReferences";
import type { DiffEditBaseRev } from "~/lib/diffEditBaseRev";
import {
  editorActivityBarSelectionLeavesEditor,
  isEditorActivityBarItemActive,
  type EditorActivityBarItem,
  editorCenterModeFamily,
  type EditorCenterMode,
} from "~/lib/editorCenterMode";
import type { FileCommentSelection } from "~/lib/fileComments";
import { cn } from "~/lib/utils";
import { useTheme } from "~/hooks/useTheme";
import { useEditorRailStore, type EditorRailItem } from "~/editorRailStore";
import { NATIVE_EDITOR_ON } from "~/betaFeatures";
import { Skeleton } from "./ui/skeleton";
import {
  ChatHeaderButton,
  ChatHeaderIconButton,
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
} from "./chat/chatHeaderControls";
import { EXPLORER_ROW_PROPS, useExplorerListNavigation } from "./chat/explorerListNavigation";
import { FileEntryIcon } from "./chat/FileEntryIcon";
import { fileRowClassName } from "./chat/fileRowStyles";
import { DiffStat } from "./chat/DiffStatLabel";
import { PanelStateMessage } from "./chat/PanelStateMessage";
import {
  ExplorerActivityBarButton,
  setFileReferenceDragData,
  WorkspaceFilesSidebar,
  WorkspaceSearchSidebar,
} from "./chat/workspaceExplorer";
import { ProjectMenuPicker, type ProjectMenuPickerOption } from "./ProjectMenuPicker";
import { FilePreviewTabs } from "./chat/DockExplorerPane";
import { WorkspaceFileDiffEditorPane } from "./chat/WorkspaceFileDiffEditorPane";
import { useQueryClient } from "@tanstack/react-query";
import { flushWorkspaceEditors } from "~/lib/workspaceEditorSession";
import { WorkspaceFileEditorPane } from "./chat/WorkspaceFileEditorPane";
import { WorkspaceFilePreview } from "./WorkspaceFilePreview";

const EDITOR_CHAT_PANE_STORAGE_KEY = "saint.editor.chatPaneWidth";
const EDITOR_SIDEBAR_VISIBLE_STORAGE_KEY = "saint.editor.sidebarVisible";
const EDITOR_CHAT_PANE_VISIBLE_STORAGE_KEY = "saint.editor.chatPaneVisible";
const EDITOR_CHAT_PANE_DEFAULT_WIDTH = 384;
const EDITOR_CHAT_PANE_MIN_WIDTH = 320;
const EDITOR_CHAT_PANE_MAX_WIDTH = 600;
const EDITOR_CHAT_PANE_KEYBOARD_STEP = 24;

interface EditorWorkspaceViewProps {
  threadId?: string | null | undefined;
  workspaceRoot: string | null;
  projectName: string | null;
  currentProjectId?: ProjectId | null;
  projectOptions?: ReadonlyArray<ProjectMenuPickerOption>;
  selectedFilePath: string | null;
  expandedDirectories: ReadonlySet<string>;
  centerMode: EditorCenterMode;
  diffFiles: ReadonlyArray<FileDiffMetadata>;
  diffFilesLoading?: boolean;
  selectedDiffFilePath: string | null;
  diffOptionsControl?: ReactNode;
  diffPanel: ReactNode;
  chatPanel: ReactNode;
  onSelectFile: (path: string) => void;
  onSelectDiffFile: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  editFilePath: string | null;
  editDiffBasePath?: string | null;
  editDiffBaseRev: DiffEditBaseRev | null;
  onCenterModeChange: (mode: EditorCenterMode) => void;
  onEditFile: (filePath: string, beforeOpen?: () => void) => void;
  onCloseEdit: () => void;
  onExitEditorView: () => void;
  /**
   * Lets the owner route its own editor-replacing actions (chat file links,
   * diff toggles) through the same dirty/saving guard as in-view exits.
   */
  leaveGuardRef?: RefObject<EditorLeaveGuard | null> | undefined;
  onReferenceInChat?: (reference: ChatFileReference) => void;
  onAskWhyInChat?: (reference: ChatFileReference) => void;
  onCommentInChat?: (comment: FileCommentSelection) => void;
  onSelectProject?: (projectId: ProjectId) => void;
}

function clampEditorChatPaneWidth(width: number): number {
  return Math.min(
    EDITOR_CHAT_PANE_MAX_WIDTH,
    Math.max(EDITOR_CHAT_PANE_MIN_WIDTH, Math.round(width)),
  );
}

function readStoredEditorChatPaneWidth(): number {
  if (typeof window === "undefined") {
    return EDITOR_CHAT_PANE_DEFAULT_WIDTH;
  }

  try {
    const rawValue = window.localStorage.getItem(EDITOR_CHAT_PANE_STORAGE_KEY);
    const parsed = rawValue === null ? Number.NaN : Number.parseFloat(rawValue);
    return Number.isFinite(parsed)
      ? clampEditorChatPaneWidth(parsed)
      : EDITOR_CHAT_PANE_DEFAULT_WIDTH;
  } catch {
    return EDITOR_CHAT_PANE_DEFAULT_WIDTH;
  }
}

function storeEditorChatPaneWidth(width: number): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      EDITOR_CHAT_PANE_STORAGE_KEY,
      String(clampEditorChatPaneWidth(width)),
    );
  } catch {
    // Best-effort preference persistence only.
  }
}

function readStoredEditorVisibility(key: string): boolean {
  if (typeof window === "undefined") {
    return true;
  }
  try {
    return window.localStorage.getItem(key) !== "false";
  } catch {
    return true;
  }
}

function storeEditorVisibility(key: string, visible: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(key, String(visible));
  } catch {
    // Best-effort preference persistence only.
  }
}

interface EditorChatPaneResizeState {
  pointerId: number;
  startX: number;
  startWidth: number;
  pendingWidth: number;
  rafId: number | null;
  restoreBodyCursor: string;
  restoreBodyUserSelect: string;
  onPointerMove: (event: PointerEvent) => void;
  onPointerEnd: (event: PointerEvent) => void;
}

function DiffFileRow(props: {
  fileDiff: FileDiffMetadata;
  selected: boolean;
  resolvedTheme: "light" | "dark";
  onSelectFile: (path: string) => void;
  onFileContextMenu: (filePath: string, position: { x: number; y: number }) => void;
}) {
  const filePath = resolveFileDiffPath(props.fileDiff);
  const { dir, name } = splitRepoRelativePath(filePath);
  const stat = summarizeFileDiffStats([props.fileDiff]);

  return (
    <button
      {...EXPLORER_ROW_PROPS}
      type="button"
      className={fileRowClassName(props.selected, "h-8 px-2")}
      title={filePath}
      draggable
      onDragStart={(event) => {
        setFileReferenceDragData(event.dataTransfer, filePath);
      }}
      onClick={() => props.onSelectFile(filePath)}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onFileContextMenu(filePath, { x: event.clientX, y: event.clientY });
      }}
    >
      <FileEntryIcon
        pathValue={filePath}
        kind="file"
        theme={props.resolvedTheme}
        className="size-3.5 shrink-0"
      />
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 items-baseline gap-1.5 overflow-hidden">
          <span className="shrink-0 truncate font-medium">{name}</span>
          {dir ? (
            <span className="min-w-0 truncate text-ui-sm text-muted-foreground/55">{dir}</span>
          ) : null}
        </div>
      </div>
      <DiffStat
        additions={stat.additions}
        deletions={stat.deletions}
        className="shrink-0 text-ui-xs tabular-nums"
      />
    </button>
  );
}

const DIFF_FILE_SKELETON_ROW_WIDTHS = ["w-10/12", "w-7/12", "w-9/12", "w-6/12", "w-8/12"];

function DiffFilesLoadingRows() {
  return (
    <div className="space-y-1 px-1 py-1" role="status" aria-label="Loading changed files...">
      {DIFF_FILE_SKELETON_ROW_WIDTHS.map((width) => (
        <div key={width} className="flex h-8 items-center gap-1.5 px-2">
          <Skeleton className="size-3.5 shrink-0 rounded-sm" />
          <Skeleton className={cn("h-3 rounded-full", width)} />
          <Skeleton className="ml-auto h-3 w-9 shrink-0 rounded-full" />
        </div>
      ))}
    </div>
  );
}

function DiffFilesSidebar(props: {
  files: ReadonlyArray<FileDiffMetadata>;
  isLoading: boolean;
  selectedFilePath: string | null;
  optionsControl?: ReactNode;
  onSelectFile: (path: string) => void;
  onReferenceInChat: ((reference: ChatFileReference) => void) | undefined;
  onAskWhyInChat: ((reference: ChatFileReference) => void) | undefined;
}) {
  const { resolvedTheme } = useTheme();
  const { onAskWhyInChat, onReferenceInChat } = props;
  const handleListKeyDown = useExplorerListNavigation();
  const totals = summarizeFileDiffStats(props.files);
  const hasDiffStats = totals.additions > 0 || totals.deletions > 0;
  const showLoadingRows = props.isLoading && props.files.length === 0;
  const handleFileContextMenu = (filePath: string, position: { x: number; y: number }) => {
    void showFileReferenceContextMenu({
      path: filePath,
      position,
      onReferenceInChat,
      onAskWhyInChat,
    });
  };

  return (
    <aside className="flex min-h-[11rem] w-full shrink-0 flex-col border-b border-border/65 app-content-surface lg:h-full lg:w-56 lg:border-b-0 lg:border-r">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/65 px-3">
        <DiffIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-ui font-medium text-foreground/86">
          Changed files
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {props.files.length > 0 ? (
            <span className="rounded-full bg-muted px-1.5 text-ui-xs font-medium text-muted-foreground tabular-nums">
              {props.files.length}
            </span>
          ) : null}
          {props.optionsControl}
        </div>
      </div>
      {hasDiffStats ? (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/45 px-3">
          <DiffStat
            additions={totals.additions}
            deletions={totals.deletions}
            className="text-ui-sm tabular-nums"
          />
        </div>
      ) : null}
      {/* Keyboard nav lives on the scrolling list, not the whole aside, so the
          header's actions menu stays out of arrow-key scope (the search sidebars
          attach at the aside because their only header control is a text input). */}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-auto px-1 py-1",
          !showLoadingRows && props.files.length === 0 && "flex flex-col",
        )}
        onKeyDown={handleListKeyDown}
      >
        {showLoadingRows ? (
          <DiffFilesLoadingRows />
        ) : props.files.length === 0 ? (
          <PanelStateMessage density="compact" fill="flex">
            <p>No files in this diff.</p>
          </PanelStateMessage>
        ) : (
          props.files.map((fileDiff) => {
            const filePath = resolveFileDiffPath(fileDiff);
            return (
              <DiffFileRow
                key={buildFileDiffRenderKey(fileDiff)}
                fileDiff={fileDiff}
                resolvedTheme={resolvedTheme}
                selected={props.selectedFilePath === filePath}
                onSelectFile={props.onSelectFile}
                onFileContextMenu={handleFileContextMenu}
              />
            );
          })
        )}
      </div>
    </aside>
  );
}

function EditorActivityBar(props: {
  centerMode: EditorCenterMode;
  searchActive: boolean;
  sidebarVisible: boolean;
  onSelectItem: (item: EditorActivityBarItem) => void;
}) {
  const centerFamily = editorCenterModeFamily(props.centerMode);
  const filesActive = props.sidebarVisible && !props.searchActive && centerFamily === "file";
  const diffActive = props.sidebarVisible && !props.searchActive && centerFamily === "diff";
  const searchActive = props.sidebarVisible && props.searchActive;
  return (
    <nav
      className="flex w-12 shrink-0 flex-col items-center border-r border-border/65 app-content-surface"
      aria-label="Editor activity bar"
    >
      <ExplorerActivityBarButton
        label={filesActive ? "Hide files sidebar" : "Files"}
        active={filesActive}
        onClick={() => props.onSelectItem("file")}
      >
        <FoldersIcon className="size-5" />
      </ExplorerActivityBarButton>
      <ExplorerActivityBarButton
        label={diffActive ? "Hide diff sidebar" : "Diff"}
        active={diffActive}
        onClick={() => props.onSelectItem("diff")}
      >
        <ChangesIcon className="size-5" />
      </ExplorerActivityBarButton>
      <ExplorerActivityBarButton
        label={searchActive ? "Hide search sidebar" : "Search files"}
        active={searchActive}
        onClick={() => props.onSelectItem("search")}
      >
        <SearchIcon className="size-5" />
      </ExplorerActivityBarButton>
    </nav>
  );
}

export interface EditorLeaveGuard {
  guardLeavingEdit: (run: () => void) => void;
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

export function EditorWorkspaceView(props: EditorWorkspaceViewProps) {
  // The editor header sits flush against the window's left edge whenever the
  // global sidebar is collapsed, so it has to clear the macOS traffic lights the
  // same way every other chat-surface header does.
  const trafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  const { resolvedTheme: editorResolvedTheme } = useTheme();
  const [chatPaneWidth, setChatPaneWidth] = useState(readStoredEditorChatPaneWidth);
  const chatPaneResizeStateRef = useRef<EditorChatPaneResizeState | null>(null);
  // Both side surfaces can be hidden so the main content takes the full width:
  // re-clicking the active activity-bar item collapses the sidebar (VS Code
  // style), and the header chat toggle hides the chat pane (kept mounted so
  // the chat runtime survives).
  const [sidebarVisible, setSidebarVisible] = useState(() =>
    readStoredEditorVisibility(EDITOR_SIDEBAR_VISIBLE_STORAGE_KEY),
  );
  const [chatPaneVisible, setChatPaneVisible] = useState(() =>
    readStoredEditorVisibility(EDITOR_CHAT_PANE_VISIBLE_STORAGE_KEY),
  );
  // The search pane replaces the explorer/diff sidebar without touching the
  // center mode, so picking a result simply opens it in the file preview. The
  // query lives here so it survives toggling between sidebar panes.
  const [searchPaneActive, setSearchPaneActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // The file preview unmounts in Diff/Edit mode. Keep explicit Markdown choices
  // in the editor shell, scoped to the workspace and file for this session.
  const [markdownPreviewModes, setMarkdownPreviewModes] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const desktopTopBarWindowControlsGutterClassName =
    useDesktopTopBarWindowControlsGutterClassName();
  const { centerMode, onCenterModeChange } = props;
  const centerFamily = editorCenterModeFamily(centerMode);

  const queryClient = useQueryClient();
  const leaveRequestRef = useRef(0);
  const guardLeavingEdit = useCallback(
    (run: () => void) => {
      const request = ++leaveRequestRef.current;
      void flushWorkspaceEditors(queryClient, props.workspaceRoot).then((saved) => {
        if (saved && request === leaveRequestRef.current) run();
      });
    },
    [queryClient, props.workspaceRoot],
  );
  useImperativeHandle(props.leaveGuardRef, () => ({ guardLeavingEdit }), [guardLeavingEdit]);
  const activityBarSelection = (item: EditorActivityBarItem) => ({
    item,
    sidebarVisible,
    searchPaneActive,
    centerFamily,
  });
  const handleActivityBarSelectItem = (item: EditorActivityBarItem) => {
    if (isEditorActivityBarItemActive(activityBarSelection(item))) {
      setSidebarVisible(false);
      storeEditorVisibility(EDITOR_SIDEBAR_VISIBLE_STORAGE_KEY, false);
      return;
    }
    if (!sidebarVisible) {
      setSidebarVisible(true);
      storeEditorVisibility(EDITOR_SIDEBAR_VISIBLE_STORAGE_KEY, true);
    }
    if (item === "search") {
      setSearchPaneActive(true);
      return;
    }
    setSearchPaneActive(false);
    onCenterModeChange(item);
  };
  // Files / Diff / Search live in the fixed rail while this view is mounted
  // (editorRailStore), so the editor has one icon column. Re-clicking the
  // active item collapses the sidebar; a center-pane switch goes through the
  // dirty-editor guard first.
  const selectRailItem = useEffectEvent((item: EditorActivityBarItem) => {
    if (editorActivityBarSelectionLeavesEditor(activityBarSelection(item)))
      guardLeavingEdit(() => handleActivityBarSelectItem(item));
    else handleActivityBarSelectItem(item);
  });
  const publishRailItems = useEditorRailStore((store) => store.publish);
  const clearRailItems = useEditorRailStore((store) => store.clear);
  const filesActive = sidebarVisible && !searchPaneActive && centerFamily === "file";
  const diffActive = sidebarVisible && !searchPaneActive && centerFamily === "diff";
  const searchActive = sidebarVisible && searchPaneActive;
  useEffect(() => {
    if (!NATIVE_EDITOR_ON) return;
    const items: EditorRailItem[] = [
      {
        id: "file",
        glyph: FoldersIcon,
        label: filesActive ? "Hide files sidebar" : "Files",
        active: filesActive,
        onSelect: () => selectRailItem("file"),
      },
      {
        id: "diff",
        glyph: ChangesIcon,
        label: diffActive ? "Hide diff sidebar" : "Diff",
        active: diffActive,
        onSelect: () => selectRailItem("diff"),
      },
      {
        id: "search",
        glyph: SearchIcon,
        label: searchActive ? "Hide search sidebar" : "Search files",
        active: searchActive,
        onSelect: () => selectRailItem("search"),
      },
    ];
    publishRailItems(items);
  }, [filesActive, diffActive, searchActive, publishRailItems]);
  useEffect(() => clearRailItems, [clearRailItems]);
  const toggleSidebarVisible = () => {
    setSidebarVisible((previous) => {
      const next = !previous;
      storeEditorVisibility(EDITOR_SIDEBAR_VISIBLE_STORAGE_KEY, next);
      return next;
    });
  };
  const toggleChatPaneVisible = () => {
    setChatPaneVisible((previous) => {
      const next = !previous;
      storeEditorVisibility(EDITOR_CHAT_PANE_VISIBLE_STORAGE_KEY, next);
      return next;
    });
  };

  const [splitLayout, setSplitLayout] = useState<EditorSplitLayoutState>(() => {
    const persisted = props.threadId ? readEditorViewState(props.threadId)?.splitLayout : null;
    const base = persisted ?? createInitialEditorSplitLayout(props.selectedFilePath);
    return syncPrimaryFileIntoSplitLayout(base, props.selectedFilePath);
  });
  const splitLayoutRef = useRef(splitLayout);
  splitLayoutRef.current = splitLayout;
  const splitLayoutThreadIdRef = useRef(props.threadId);
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

  useEffect(() => {
    if (splitLayoutThreadIdRef.current !== props.threadId) {
      splitLayoutThreadIdRef.current = props.threadId;
      const persisted = props.threadId ? readEditorViewState(props.threadId)?.splitLayout : null;
      const base = persisted ?? createInitialEditorSplitLayout(props.selectedFilePath);
      const next = syncPrimaryFileIntoSplitLayout(base, props.selectedFilePath);
      splitLayoutRef.current = next;
      setSplitLayout(next);
      return;
    }
    if (!props.selectedFilePath) return;
    setSplitLayout((current) => syncPrimaryFileIntoSplitLayout(current, props.selectedFilePath));
  }, [props.threadId, props.selectedFilePath]);

  useEffect(() => {
    if (!props.threadId || splitLayoutThreadIdRef.current !== props.threadId) return;
    storeEditorSplitLayout(props.threadId, splitLayout);
  }, [props.threadId, splitLayout]);

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

  const handleCloseTabInGroup = (groupId: string, filePath: string) => {
    guardLeavingEdit(() => {
      const next = closeFileInSplitGroup(splitLayoutRef.current, groupId, filePath);
      splitLayoutRef.current = next;
      setSplitLayout(next);
      const activeGroup =
        next.groups.find((group) => group.id === next.activeGroupId) ?? next.groups[0];
      if (
        activeGroup?.selectedFilePath &&
        activeGroup.selectedFilePath !== props.selectedFilePath
      ) {
        props.onSelectFile(activeGroup.selectedFilePath);
      }
    });
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

  const stopChatPaneResize = () => {
    const resizeState = chatPaneResizeStateRef.current;
    if (!resizeState || typeof window === "undefined") {
      return;
    }

    if (resizeState.rafId !== null) {
      window.cancelAnimationFrame(resizeState.rafId);
      resizeState.rafId = null;
    }

    window.removeEventListener("pointermove", resizeState.onPointerMove);
    window.removeEventListener("pointerup", resizeState.onPointerEnd);
    window.removeEventListener("pointercancel", resizeState.onPointerEnd);
    document.body.style.cursor = resizeState.restoreBodyCursor;
    document.body.style.userSelect = resizeState.restoreBodyUserSelect;
    setChatPaneWidth(resizeState.pendingWidth);
    storeEditorChatPaneWidth(resizeState.pendingWidth);
    chatPaneResizeStateRef.current = null;
  };

  useEffect(() => stopChatPaneResize, [stopChatPaneResize]);

  const handleChatPaneResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || typeof window === "undefined") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    stopChatPaneResize();

    const resizeState: EditorChatPaneResizeState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: chatPaneWidth,
      pendingWidth: chatPaneWidth,
      rafId: null,
      restoreBodyCursor: document.body.style.cursor,
      restoreBodyUserSelect: document.body.style.userSelect,
      onPointerMove: () => undefined,
      onPointerEnd: () => undefined,
    };

    resizeState.onPointerMove = (moveEvent) => {
      if (moveEvent.pointerId !== resizeState.pointerId) {
        return;
      }

      resizeState.pendingWidth = clampEditorChatPaneWidth(
        resizeState.startWidth + resizeState.startX - moveEvent.clientX,
      );

      if (resizeState.rafId !== null) {
        return;
      }

      resizeState.rafId = window.requestAnimationFrame(() => {
        resizeState.rafId = null;
        setChatPaneWidth(resizeState.pendingWidth);
      });
    };

    resizeState.onPointerEnd = (endEvent) => {
      if (endEvent.pointerId !== resizeState.pointerId) {
        return;
      }
      stopChatPaneResize();
    };

    chatPaneResizeStateRef.current = resizeState;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", resizeState.onPointerMove);
    window.addEventListener("pointerup", resizeState.onPointerEnd);
    window.addEventListener("pointercancel", resizeState.onPointerEnd);
  };

  const guardedSelectFile = (filePath: string) => {
    guardLeavingEdit(() => {
      setSplitLayout((current) => syncPrimaryFileIntoSplitLayout(current, filePath));
      props.onSelectFile(filePath);
    });
  };

  const activeSplitGroup =
    splitLayout.groups.find((candidate) => candidate.id === splitLayout.activeGroupId) ??
    splitLayout.groups[0];
  const fileEditGroupId =
    props.centerMode === "fileEdit" && props.editFilePath !== null
      ? activeSplitGroup?.selectedFilePath === props.editFilePath
        ? activeSplitGroup.id
        : (splitLayout.groups.find((candidate) => candidate.selectedFilePath === props.editFilePath)
            ?.id ?? null)
      : null;

  const guardedSelectDiffFile = (filePath: string) => {
    guardLeavingEdit(() => props.onSelectDiffFile(filePath));
  };

  const handleChatPaneResizeDoubleClick = () => {
    setChatPaneWidth(EDITOR_CHAT_PANE_DEFAULT_WIDTH);
    storeEditorChatPaneWidth(EDITOR_CHAT_PANE_DEFAULT_WIDTH);
  };

  const handleChatPaneResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number | null = null;

    if (event.key === "ArrowLeft") {
      nextWidth = chatPaneWidth + EDITOR_CHAT_PANE_KEYBOARD_STEP;
    } else if (event.key === "ArrowRight") {
      nextWidth = chatPaneWidth - EDITOR_CHAT_PANE_KEYBOARD_STEP;
    } else if (event.key === "Home") {
      nextWidth = EDITOR_CHAT_PANE_MIN_WIDTH;
    } else if (event.key === "End") {
      nextWidth = EDITOR_CHAT_PANE_MAX_WIDTH;
    }

    if (nextWidth === null) {
      return;
    }

    event.preventDefault();
    const clampedWidth = clampEditorChatPaneWidth(nextWidth);
    setChatPaneWidth(clampedWidth);
    storeEditorChatPaneWidth(clampedWidth);
  };

  return (
    <div
      data-editor-workspace
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col app-content-surface text-foreground"
    >
      <div
        className={cn(
          "flex shrink-0 items-center gap-2 px-2 sm:px-3",
          CHAT_SURFACE_HEADER_HEIGHT_CLASS,
          CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
          desktopTopBarWindowControlsGutterClassName,
        )}
      >
        <div
          className={cn("flex min-w-0 flex-1 items-center gap-1.5", trafficLightGutterClassName)}
        >
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-ui-lg font-medium text-foreground">
              {props.projectName ?? "Workspace"}
            </span>
            <span className="hidden truncate text-ui-sm text-muted-foreground/70 sm:inline">
              {props.workspaceRoot ?? "No workspace"}
            </span>
          </div>
          {props.onSelectProject && (props.projectOptions?.length ?? 0) > 0 ? (
            <ProjectMenuPicker
              projectOptions={props.projectOptions ?? []}
              selectedProjectId={props.currentProjectId ?? null}
              onProjectIdChange={(projectId) =>
                guardLeavingEdit(() => props.onSelectProject?.(projectId))
              }
              trigger={
                <ChatHeaderIconButton
                  type="button"
                  tone="plain"
                  label="Switch project"
                  title="Switch project"
                  className="size-6"
                >
                  <ChevronDownIcon className="size-3.5" />
                </ChatHeaderIconButton>
              }
            />
          ) : null}
        </div>
        <ChatHeaderButton
          type="button"
          tone="outline"
          aria-pressed={sidebarVisible}
          aria-label={sidebarVisible ? "Hide file explorer" : "Show file explorer"}
          title={sidebarVisible ? "Hide file explorer" : "Show file explorer"}
          className="gap-1.5"
          onClick={toggleSidebarVisible}
        >
          <PanelLeftIcon className="size-3.5" />
          <span className="sr-only">
            {sidebarVisible ? "Hide file explorer" : "Show file explorer"}
          </span>
        </ChatHeaderButton>
        <ChatHeaderButton
          type="button"
          tone="outline"
          aria-pressed={chatPaneVisible}
          aria-label={chatPaneVisible ? "Hide chat panel" : "Show chat panel"}
          title={chatPaneVisible ? "Hide chat panel" : "Show chat panel"}
          className="gap-1.5"
          onClick={toggleChatPaneVisible}
        >
          <PanelRightCloseIcon className="size-3.5" />
          <span className="sr-only">{chatPaneVisible ? "Hide chat panel" : "Show chat panel"}</span>
        </ChatHeaderButton>
        <ChatHeaderButton
          type="button"
          tone="outline"
          aria-pressed={true}
          title="Switch to chat view"
          className="w-[5.5rem] gap-1.5"
          onClick={() => guardLeavingEdit(props.onExitEditorView)}
        >
          <ChatBubbleIcon className="size-3.5" />
          <span className="truncate font-normal">Chat</span>
        </ChatHeaderButton>
      </div>
      {/* The body sits on the content block below the top bar; clip the opaque
          panes to the block's rounded corners so none paints a square over them. */}
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 overflow-hidden",
          NATIVE_EDITOR_ON && "[border-radius:var(--app-rail-block-radii,0)]",
        )}
      >
        {!NATIVE_EDITOR_ON && (
          <EditorActivityBar
            centerMode={props.centerMode}
            searchActive={searchPaneActive}
            sidebarVisible={sidebarVisible}
            onSelectItem={(item) =>
              editorActivityBarSelectionLeavesEditor(activityBarSelection(item))
                ? guardLeavingEdit(() => handleActivityBarSelectItem(item))
                : handleActivityBarSelectItem(item)
            }
          />
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden lg:flex-row">
          {!sidebarVisible ? null : searchPaneActive ? (
            <WorkspaceSearchSidebar
              workspaceRoot={props.workspaceRoot}
              query={searchQuery}
              onQueryChange={setSearchQuery}
              selectedFilePath={props.selectedFilePath}
              onSelectFile={guardedSelectFile}
              onReferenceInChat={props.onReferenceInChat}
            />
          ) : centerFamily === "diff" ? (
            <DiffFilesSidebar
              files={props.diffFiles}
              isLoading={props.diffFilesLoading ?? false}
              selectedFilePath={props.selectedDiffFilePath}
              optionsControl={props.diffOptionsControl}
              onSelectFile={guardedSelectDiffFile}
              onReferenceInChat={props.onReferenceInChat}
              onAskWhyInChat={props.onAskWhyInChat}
            />
          ) : (
            <WorkspaceFilesSidebar
              workspaceRoot={props.workspaceRoot}
              selectedFilePath={props.selectedFilePath}
              expandedDirectories={props.expandedDirectories}
              onSelectFile={guardedSelectFile}
              onToggleDirectory={props.onToggleDirectory}
              onReferenceInChat={props.onReferenceInChat}
            />
          )}
          <WorkspaceFileOpenerContext.Provider
            value={{
              openFile: (path, beforeOpen) => {
                const target = resolveWorkspaceFileOpenTarget(path, props.workspaceRoot);
                if (!target) return false;
                // The parent owns the final save guard and prepares the reveal
                // only when it accepts this editing request.
                props.onEditFile(target, beforeOpen);
                return true;
              },
            }}
          >
            <main className="flex min-h-[16rem] min-w-0 flex-1 border-b border-border/65 lg:h-full lg:border-b-0">
              {/* Keep the diff panel mounted while browsing files: unmounting it
                drops the parsed patch, diff worker pool, and query subscriptions,
                which made every Files -> Diff switch a cold multi-second reload. */}
              <div
                className={cn("min-h-0 min-w-0 flex-1", props.centerMode !== "diff" && "hidden")}
              >
                {props.diffPanel}
              </div>
              {props.centerMode === "diffEdit" && props.editFilePath !== null ? (
                <div className="flex min-h-0 min-w-0 flex-1">
                  <WorkspaceFileDiffEditorPane
                    onReferenceInChat={props.onReferenceInChat}
                    workspaceRoot={props.workspaceRoot}
                    filePath={props.editFilePath}
                    basePath={props.editDiffBasePath ?? null}
                    baseRev={props.editDiffBaseRev ?? { rev: "HEAD" }}
                    resolvedTheme={editorResolvedTheme}
                    onClose={props.onCloseEdit}
                  />
                </div>
              ) : props.centerMode === "file" || props.centerMode === "fileEdit" ? (
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
                      const groupMarkdownKey = `${props.workspaceRoot ?? ""}\0${groupFilePath ?? ""}`;
                      const groupSizePercent =
                        splitLayout.sizes[groupIndex] ?? 100 / splitLayout.groups.length;
                      const activeZoneForGroup =
                        hoveredDropZone?.groupId === group.id ? hoveredDropZone.zone : null;
                      const handleGroupDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
                        const types = Array.from(event.dataTransfer.types);
                        if (!types.includes(CHAT_FILE_REFERENCE_DRAG_TYPE)) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "copy";
                        const rect = event.currentTarget.getBoundingClientRect();
                        const zone = resolveSplitDropZoneFromPoint(
                          rect,
                          event.clientX,
                          event.clientY,
                        );
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
                        setHoveredDropZone((previous) =>
                          previous?.groupId === group.id ? null : previous,
                        );
                      };
                      const handleGroupDrop = (event: ReactDragEvent<HTMLDivElement>) => {
                        const droppedPath = extractDroppedFilePath(event.dataTransfer);
                        const sourceGroup =
                          event.dataTransfer.getData("application/x-saint-editor-group") || null;
                        setHoveredDropZone(null);
                        if (!droppedPath) return;
                        event.preventDefault();
                        const rect = event.currentTarget.getBoundingClientRect();
                        const zone = resolveSplitDropZoneFromPoint(
                          rect,
                          event.clientX,
                          event.clientY,
                        );
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
                              {fileEditGroupId === group.id && props.editFilePath !== null ? (
                                <WorkspaceFileEditorPane
                                  onReferenceInChat={props.onReferenceInChat}
                                  workspaceRoot={props.workspaceRoot}
                                  filePath={props.editFilePath}
                                  resolvedTheme={editorResolvedTheme}
                                  onClose={props.onCloseEdit}
                                />
                              ) : (
                                <WorkspaceFilePreview
                                  workspaceRoot={props.workspaceRoot}
                                  filePath={groupFilePath}
                                  markdownPreviewEnabled={
                                    markdownPreviewModes.get(groupMarkdownKey) ?? true
                                  }
                                  onMarkdownPreviewChange={(rendered) => {
                                    setMarkdownPreviewModes((current) =>
                                      new Map(current).set(groupMarkdownKey, rendered),
                                    );
                                  }}
                                  onReferenceInChat={props.onReferenceInChat}
                                  onAskWhyInChat={props.onAskWhyInChat}
                                  onCommentInChat={props.onCommentInChat}
                                  onEditFile={props.onEditFile}
                                />
                              )}
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
                              onPointerDown={(event) =>
                                handleSplitDividerPointerDown(groupIndex, event)
                              }
                              onKeyDown={(event) => handleSplitDividerKeyDown(groupIndex, event)}
                            />
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </div>
                </DndContext>
              ) : null}
            </main>
          </WorkspaceFileOpenerContext.Provider>
          <div
            role="separator"
            aria-label="Resize chat panel"
            aria-orientation="vertical"
            aria-valuemin={EDITOR_CHAT_PANE_MIN_WIDTH}
            aria-valuemax={EDITOR_CHAT_PANE_MAX_WIDTH}
            aria-valuenow={chatPaneWidth}
            tabIndex={0}
            title="Drag to resize chat panel"
            className={cn(
              "group relative z-10 w-0 shrink-0 cursor-col-resize outline-none",
              chatPaneVisible ? "hidden lg:block" : "hidden",
            )}
            onPointerDown={handleChatPaneResizePointerDown}
            onDoubleClick={handleChatPaneResizeDoubleClick}
            onKeyDown={handleChatPaneResizeKeyDown}
          >
            <span
              className="absolute inset-y-0 left-[-3px] w-1.5 cursor-col-resize bg-transparent transition-colors group-hover:bg-[var(--color-background-button-secondary-hover)] group-focus-visible:bg-[var(--color-background-button-secondary-hover)]"
              aria-hidden="true"
            />
            <span
              className="pointer-events-none absolute inset-y-0 left-0 w-px bg-[var(--app-surface-divider)] transition-colors group-hover:bg-[var(--color-text-accent)] group-focus-visible:bg-[var(--color-text-accent)]"
              aria-hidden="true"
            />
          </div>
          {/* Hidden (not unmounted) so the chat runtime and composer focus
              state survive toggling the pane. */}
          <aside
            className={cn(
              "min-h-[18rem] w-full shrink-0 app-content-surface lg:h-full lg:w-[var(--editor-chat-pane-width)]",
              chatPaneVisible ? "flex" : "hidden",
            )}
            style={
              {
                "--editor-chat-pane-width": `${chatPaneWidth}px`,
              } as CSSProperties
            }
          >
            {props.chatPanel}
          </aside>
        </div>
      </div>
    </div>
  );
}

export default EditorWorkspaceView;
