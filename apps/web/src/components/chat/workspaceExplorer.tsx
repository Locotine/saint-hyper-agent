// FILE: workspaceExplorer.tsx
// Purpose: Shared workspace file-tree explorer + file-search building blocks used
//          by both the full editor view and the right-dock explorer pane.
// Layer: Chat workspace-browsing UI primitives
// Exports: WorkspaceFilesSidebar, WorkspaceSearchSidebar, WorkspaceExplorerSidebar,
//          useExplorerEntryPrefetch, setFileReferenceDragData, ExplorerActivityBarButton.

import { useHostId } from "~/hosts/hostScope";
import type { ProjectEntry, ProjectFileSystemEntry } from "@saint/contracts";
import {
  isLocalAbsolutePath,
  joinWorkspaceRelativePath,
  localPathsEqual,
  workspaceRelativePathOf,
} from "@saint/shared/path";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ComponentPropsWithoutRef,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  forwardRef,
  useEffect,
  useEffectEvent,
  useState,
} from "react";

import {
  CHAT_FILE_REFERENCE_DRAG_TYPE,
  formatChatFileReference,
  type ChatFileReference,
} from "~/lib/chatReferences";
import { splitRepoRelativePath } from "~/lib/diffRendering";
import { showFileReferenceContextMenu } from "~/lib/fileReferenceContextMenu";
import {
  projectListDirectoriesQueryOptions,
  projectReadFileQueryOptions,
  projectSearchEntriesQueryOptions,
} from "~/lib/projectReactQuery";
import {
  ArrowLeftIcon,
  ArrowUpIcon,
  DownloadIcon,
  EyeIcon,
  FolderIcon,
  RefreshCwIcon,
  RotateCcwIcon,
} from "~/lib/icons";
import { getSyntaxHighlighterPromise, getSyntaxLanguageForPath } from "~/lib/syntaxHighlighting";
import { cn } from "~/lib/utils";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { Schema } from "effect";
import {
  folderNameOfWorkspaceRoot,
  joinChildWorkspaceRoot,
  parentWorkspaceRoot,
} from "~/lib/workspaceDownload";
import { useWorkspaceUploadProgress } from "~/lib/workspaceUpload";
import { Skeleton } from "../ui/skeleton";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { IconButton } from "../ui/icon-button";
import { SearchInput } from "../ui/search-input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { type ExplorerTreeSelection, useExplorerEntryActions } from "./explorerEntryActions";
import type { ExplorerSelectableEntry } from "./explorerSelection";
import {
  EXPLORER_DROP_DIRECTORY_ATTRIBUTE,
  EXPLORER_DROP_TARGET_CLASS_NAME,
  endExplorerEntriesDrag,
  explorerDropDirectoryFor,
  invalidateExplorerDirectories,
  useExplorerFileDrop,
} from "./explorerFileDrop";
import { EXPLORER_TREE_ATTRIBUTE, explorerEntryRowAttributes } from "./explorerSelection";
import { EXPLORER_ROW_PROPS, useExplorerListNavigation } from "./explorerListNavigation";
import { FileEntryIcon } from "./FileEntryIcon";
import { fileRowClassName, fileRowIndentStyle } from "./fileRowStyles";
import { PanelStateMessage } from "./PanelStateMessage";

const EXPLORER_HIDDEN_DIRECTORY_NAMES = new Set([
  ".cache",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".pnpm-store",
  ".svelte-kit",
  ".turbo",
  ".vite",
  ".yarn",
  "node_modules",
]);

// Mirrors the composer mention search: debounce keystrokes so they don't fan
// out into fuzzy-search RPCs, and cap results to keep the sidebar light.
const EXPLORER_SEARCH_QUERY_DEBOUNCE_MS = 120;
const EXPLORER_SEARCH_RESULTS_LIMIT = 80;
// How long a drag rests on a collapsed folder before it opens.
const EXPLORER_DRAG_EXPAND_DELAY_MS = 500;
const EMPTY_WORKSPACE_SEARCH_FILE_MATCHES: ReadonlyArray<ProjectEntry> = [];
const EMPTY_EXPANDED_DIRECTORIES: ReadonlySet<string> = new Set<string>();
const EMPTY_EXPANDED_DIRECTORIES_BY_ROOT: ReadonlyMap<string, ReadonlySet<string>> = new Map();

function toFullPath(entryPath: string, root: string): string {
  return isLocalAbsolutePath(entryPath) ? entryPath : joinWorkspaceRelativePath(root, entryPath);
}

/**
 * Converts an entry path relative to `activeRoot` into the path representation
 * expected by a consumer rooted at `baseRoot`: a `baseRoot`-relative path when
 * the file is inside `baseRoot`, or a normalized absolute path when the user
 * has navigated outside `baseRoot`.
 */
export function resolveExplorerPathForBaseRoot(
  entryPath: string,
  activeRoot: string | null,
  baseRoot: string | null,
): string {
  if (!entryPath || !activeRoot || !baseRoot || localPathsEqual(activeRoot, baseRoot)) {
    return entryPath;
  }
  const fullPath = toFullPath(entryPath, activeRoot);
  return workspaceRelativePathOf(fullPath, baseRoot) ?? fullPath;
}

/**
 * Resolves an entry path relative to `activeRoot` into a `baseRoot`-relative
 * path for consumers whose URL route param is fixed to `baseRoot` (such as
 * `SingleChatSurface`'s `?editorFilePath=`). Returns `null` when the entry
 * lies outside `baseRoot`.
 */
export function resolveSelectablePathForBaseRoot(
  entryPath: string,
  activeRoot: string | null,
  baseRoot: string | null,
): string | null {
  if (!entryPath) {
    return null;
  }
  if (!activeRoot || !baseRoot) {
    return isLocalAbsolutePath(entryPath) ? null : entryPath;
  }
  if (localPathsEqual(activeRoot, baseRoot) && !isLocalAbsolutePath(entryPath)) {
    return entryPath;
  }
  return workspaceRelativePathOf(toFullPath(entryPath, activeRoot), baseRoot);
}

/**
 * Converts a consumer's `selectedFilePath` (relative to `baseRoot` or absolute)
 * into a path relative to `activeRoot` so the active tree/search highlights it.
 */
export function resolveSelectedFilePathForActiveRoot(
  selectedFilePath: string | null,
  activeRoot: string | null,
  baseRoot: string | null,
): string | null {
  if (!selectedFilePath || !activeRoot || !baseRoot || localPathsEqual(activeRoot, baseRoot)) {
    return selectedFilePath;
  }
  return workspaceRelativePathOf(toFullPath(selectedFilePath, baseRoot), activeRoot);
}

export function wrapReferenceInChatForActiveRoot(
  onReferenceInChat: ((reference: ChatFileReference) => void) | undefined,
  activeRoot: string | null,
  baseRoot: string | null,
): ((reference: ChatFileReference) => void) | undefined {
  if (!onReferenceInChat || !activeRoot || !baseRoot || localPathsEqual(activeRoot, baseRoot)) {
    return onReferenceInChat;
  }
  return (reference) =>
    onReferenceInChat({
      ...reference,
      path: resolveExplorerPathForBaseRoot(reference.path, activeRoot, baseRoot),
    });
}

// Default sidebar shell: a full-height column in the editor's wide row layout
// that collapses to a stacked block on narrow viewports. Surfaces with a fixed
// horizontal layout (e.g. the right dock) override this via `containerClassName`.
const EXPLORER_SIDEBAR_CONTAINER_CLASS =
  "flex min-h-[11rem] w-full shrink-0 flex-col border-b border-border/65 app-content-surface lg:h-full lg:w-56 lg:border-b-0 lg:border-r";

// Marks the drag payload so the chat composer can accept it as a reference.
export function setFileReferenceDragData(dataTransfer: DataTransfer, path: string): void {
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(CHAT_FILE_REFERENCE_DRAG_TYPE, formatChatFileReference({ path }));
  dataTransfer.setData("text/plain", path);
}

const SHOW_HIDDEN_STORAGE_KEY = "saint:explorer:show-hidden";

/** Whether the Explorer lists everything it hides by default (`.git`, `.saint*`, build caches). */
function useExplorerShowHidden() {
  return useLocalStorage(SHOW_HIDDEN_STORAGE_KEY, false, Schema.Boolean);
}

function shouldShowExplorerEntry(entry: ProjectFileSystemEntry): boolean {
  if (entry.kind !== "directory") {
    return true;
  }
  if (entry.name.startsWith(".saint")) {
    return false;
  }
  return !EXPLORER_HIDDEN_DIRECTORY_NAMES.has(entry.name);
}

/**
 * Warms caches for an explorer entry before it is clicked: directory listings
 * for folders, file contents plus the matching syntax highlighter for files.
 */
export function useExplorerEntryPrefetch(cwd: string | null) {
  const queryClient = useQueryClient();
  const hostId = useHostId();
  const [showHidden] = useExplorerShowHidden();
  return (entry: Pick<ProjectFileSystemEntry, "path" | "kind">) => {
    if (!cwd) {
      return;
    }
    if (entry.kind === "directory") {
      void queryClient.prefetchQuery(
        projectListDirectoriesQueryOptions({
          cwd,
          relativePath: entry.path,
          includeFiles: true,
          includeHidden: showHidden,
          hostId,
        }),
      );
      return;
    }
    void queryClient.prefetchQuery(
      projectReadFileQueryOptions({ cwd, relativePath: entry.path, hostId }),
    );
    void getSyntaxHighlighterPromise(getSyntaxLanguageForPath(entry.path)).catch(() => undefined);
  };
}

// Forwards its ref and spreads incoming props so directory rows can act as the
// Collapsible trigger (Base UI injects onClick/aria/data + ref onto this element).
const ExplorerRow = forwardRef<
  HTMLButtonElement,
  {
    entry: ProjectFileSystemEntry;
    depth: number;
    selected: boolean;
    expanded: boolean;
    /** Highlights a folder row while local files or Explorer rows are dragged over it. */
    dropTarget?: boolean;
    selection: ExplorerTreeSelection;
    onSelectFile: (path: string) => void;
    onNavigateIntoDirectory?: ((relativePath: string) => void) | undefined;
    onPrefetchEntry: (entry: ProjectFileSystemEntry) => void;
    onEntryContextMenu: (entry: ProjectFileSystemEntry, position: { x: number; y: number }) => void;
  } & ComponentPropsWithoutRef<"button">
>(function ExplorerRow(
  {
    entry,
    depth,
    selected,
    expanded,
    dropTarget = false,
    selection,
    onSelectFile,
    onNavigateIntoDirectory,
    onPrefetchEntry,
    onEntryContextMenu,
    className,
    onClick,
    ...rest
  },
  ref,
) {
  const isDirectory = entry.kind === "directory";
  // Directory rows are the Collapsible trigger: chain Base UI's injected onClick
  // (which toggles open/close) and skip file selection. File rows open the preview.
  // Cmd/Ctrl/Shift-clicks only change the multi-selection.
  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (selection.onRowClick(entry, event)) return;
    onClick?.(event);
    if (isDirectory) {
      return;
    }
    onSelectFile(entry.path);
  };
  const handleDoubleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (!isDirectory || !onNavigateIntoDirectory) return;
    event.preventDefault();
    event.stopPropagation();
    onNavigateIntoDirectory(entry.path);
  };
  const handlePrefetch = () => {
    onPrefetchEntry(entry);
  };
  const handleContextMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    onEntryContextMenu(entry, { x: event.clientX, y: event.clientY });
  };
  const handleDragStart = (event: ReactDragEvent<HTMLButtonElement>) => {
    setFileReferenceDragData(event.dataTransfer, entry.path);
    selection.onRowDragStart(entry, event.dataTransfer);
  };

  return (
    <button
      {...rest}
      {...EXPLORER_ROW_PROPS}
      ref={ref}
      type="button"
      className={fileRowClassName(
        selected,
        cn("h-7 pr-2", dropTarget && EXPLORER_DROP_TARGET_CLASS_NAME, className),
      )}
      style={fileRowIndentStyle(depth)}
      title={entry.path}
      {...{ [EXPLORER_DROP_DIRECTORY_ATTRIBUTE]: explorerDropDirectoryFor(entry) }}
      {...explorerEntryRowAttributes(entry)}
      data-selected={selected ? "" : undefined}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={endExplorerEntriesDrag}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onPointerEnter={handlePrefetch}
      onFocus={handlePrefetch}
      onContextMenu={handleContextMenu}
    >
      {isDirectory ? (
        <DisclosureChevron open={expanded} className="opacity-75" />
      ) : (
        <FileEntryIcon
          pathValue={entry.path}
          kind={entry.kind}
          className="size-3.5 shrink-0 opacity-75"
        />
      )}
      <span className="min-w-0 truncate">{entry.name}</span>
    </button>
  );
});

const EXPLORER_SKELETON_ROW_WIDTHS = ["w-9/12", "w-6/12", "w-7/12"];

function ExplorerLoadingRows(props: { depth: number }) {
  return (
    <div
      className="space-y-1.5 py-1.5 pr-2"
      style={fileRowIndentStyle(props.depth)}
      role="status"
      aria-label="Loading directory..."
    >
      {EXPLORER_SKELETON_ROW_WIDTHS.map((width) => (
        <div key={width} className="flex h-5 items-center gap-1.5">
          <Skeleton className="size-3.5 shrink-0 rounded-sm" />
          <Skeleton className={cn("h-3 rounded-full", width)} />
        </div>
      ))}
    </div>
  );
}

function WorkspaceDirectory(props: {
  cwd: string;
  relativePath: string | null;
  depth: number;
  selectedFilePath: string | null;
  selection: ExplorerTreeSelection;
  expandedDirectories: ReadonlySet<string>;
  dropDirectory: string | null;
  onSelectFile: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  onNavigateIntoDirectory?: ((relativePath: string) => void) | undefined;
  onPrefetchEntry: (entry: ProjectFileSystemEntry) => void;
  onEntryContextMenu: (entry: ProjectFileSystemEntry, position: { x: number; y: number }) => void;
}) {
  const { selectedPaths } = props.selection;
  const hostId = useHostId();
  const [showHidden] = useExplorerShowHidden();
  const query = useQuery(
    projectListDirectoriesQueryOptions({
      cwd: props.cwd,
      relativePath: props.relativePath,
      includeFiles: true,
      includeHidden: showHidden,
      hostId,
    }),
  );

  if (query.isLoading && !query.data) {
    return <ExplorerLoadingRows depth={props.depth} />;
  }

  if (query.error) {
    return (
      <p className="px-3 py-2 text-ui-sm text-destructive/80">
        {query.error instanceof Error ? query.error.message : "Could not load directory."}
      </p>
    );
  }

  return (
    <>
      {(query.data?.entries ?? [])
        .filter((entry) => showHidden || shouldShowExplorerEntry(entry))
        .map((entry) => {
          if (entry.kind !== "directory") {
            return (
              <ExplorerRow
                key={entry.path}
                entry={entry}
                depth={props.depth}
                selected={
                  selectedPaths
                    ? selectedPaths.has(entry.path)
                    : entry.path === props.selectedFilePath
                }
                expanded={false}
                selection={props.selection}
                onSelectFile={props.onSelectFile}
                onPrefetchEntry={props.onPrefetchEntry}
                onEntryContextMenu={props.onEntryContextMenu}
              />
            );
          }
          const expanded = props.expandedDirectories.has(entry.path);
          return (
            <Collapsible
              key={entry.path}
              open={expanded}
              onOpenChange={() => props.onToggleDirectory(entry.path)}
            >
              <CollapsibleTrigger
                render={
                  <ExplorerRow
                    entry={entry}
                    depth={props.depth}
                    selected={selectedPaths?.has(entry.path) ?? false}
                    expanded={expanded}
                    dropTarget={entry.path === props.dropDirectory}
                    selection={props.selection}
                    onSelectFile={props.onSelectFile}
                    onNavigateIntoDirectory={props.onNavigateIntoDirectory}
                    onPrefetchEntry={props.onPrefetchEntry}
                    onEntryContextMenu={props.onEntryContextMenu}
                  />
                }
              />
              {/* Keep children mounted only while open (plus the closing transition Base UI
                manages) so the height animation plays and lazy listings stay cached. */}
              <CollapsiblePanel>
                <WorkspaceDirectory
                  cwd={props.cwd}
                  relativePath={entry.path}
                  depth={props.depth + 1}
                  selectedFilePath={props.selectedFilePath}
                  selection={props.selection}
                  expandedDirectories={props.expandedDirectories}
                  dropDirectory={props.dropDirectory}
                  onSelectFile={props.onSelectFile}
                  onToggleDirectory={props.onToggleDirectory}
                  onNavigateIntoDirectory={props.onNavigateIntoDirectory}
                  onPrefetchEntry={props.onPrefetchEntry}
                  onEntryContextMenu={props.onEntryContextMenu}
                />
              </CollapsiblePanel>
            </Collapsible>
          );
        })}
    </>
  );
}

// Opening the file-reference context menu from a tree row (full entry) or a
// search-result row (path only). Both wrap the same menu, so they live here
// instead of being re-declared in every sidebar that renders these rows.
function useResultEntryContextMenu(
  onReferenceInChat: ((reference: ChatFileReference) => void) | undefined,
  workspaceRoot: string | null,
) {
  return (path: string, position: { x: number; y: number }) => {
    void showFileReferenceContextMenu({ path, position, onReferenceInChat, workspaceRoot });
  };
}

// Scrollable file-tree body, shared by the standalone files sidebar and the
// combined explorer sidebar (which shows it whenever the search box is empty).
function WorkspaceFilesTreeBody(props: {
  workspaceRoot: string | null;
  selectedFilePath: string | null;
  selection: ExplorerTreeSelection;
  expandedDirectories: ReadonlySet<string>;
  onSelectFile: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  onNavigateUp?: (() => void) | undefined;
  onNavigateIntoDirectory?: ((relativePath: string) => void) | undefined;
  onPrefetchEntry: (entry: ProjectFileSystemEntry) => void;
  onEntryContextMenu: (entry: ProjectFileSystemEntry, position: { x: number; y: number }) => void;
  onRootContextMenu: (position: { x: number; y: number }) => void;
  onMoveEntries: (paths: string[], directory: string) => void;
}) {
  const hostId = useHostId();
  const fileDrop = useExplorerFileDrop(props.workspaceRoot, props.onMoveEntries, hostId);
  const { dropDirectory } = fileDrop;
  // Read at fire time, so parent re-renders during the drag do not restart the wait.
  const expandHeldDirectory = useEffectEvent((directory: string) => {
    if (!props.expandedDirectories.has(directory)) props.onToggleDirectory(directory);
  });
  // Like VS Code, a collapsed folder held under a drag opens after a moment.
  useEffect(() => {
    if (!dropDirectory) return;
    const timer = window.setTimeout(
      () => expandHeldDirectory(dropDirectory),
      EXPLORER_DRAG_EXPAND_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [dropDirectory]);
  const parentRoot = props.workspaceRoot ? parentWorkspaceRoot(props.workspaceRoot) : null;
  return (
    <div
      className={cn(
        "min-h-0 flex-1 overflow-auto px-1 py-1",
        fileDrop.dropDirectory === "" && EXPLORER_DROP_TARGET_CLASS_NAME,
      )}
      {...{ [EXPLORER_TREE_ATTRIBUTE]: "" }}
      {...fileDrop.handlers}
      onKeyDown={props.selection.onTreeKeyDown}
      onContextMenu={(event) => {
        // Rows open their own menu; only empty space below them lands here.
        if ((event.target as Element).closest(`[${EXPLORER_DROP_DIRECTORY_ATTRIBUTE}]`)) return;
        event.preventDefault();
        props.onRootContextMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      {props.workspaceRoot ? (
        <>
          {parentRoot && props.onNavigateUp ? (
            <button
              {...EXPLORER_ROW_PROPS}
              type="button"
              className={fileRowClassName(
                false,
                "h-7 pr-2 text-muted-foreground hover:text-foreground",
              )}
              style={fileRowIndentStyle(0)}
              title={`Parent folder (${parentRoot})`}
              onClick={props.onNavigateUp}
            >
              <ArrowUpIcon className="size-3.5 shrink-0 opacity-75" />
              <span className="min-w-0 truncate font-medium">..</span>
            </button>
          ) : null}
          <WorkspaceDirectory
            cwd={props.workspaceRoot}
            relativePath={null}
            depth={0}
            selectedFilePath={props.selectedFilePath}
            selection={props.selection}
            expandedDirectories={props.expandedDirectories}
            dropDirectory={fileDrop.dropDirectory}
            onSelectFile={props.onSelectFile}
            onToggleDirectory={props.onToggleDirectory}
            onNavigateIntoDirectory={props.onNavigateIntoDirectory}
            onPrefetchEntry={props.onPrefetchEntry}
            onEntryContextMenu={props.onEntryContextMenu}
          />
        </>
      ) : (
        <PanelStateMessage density="compact" fill="flex">
          <p>No workspace.</p>
        </PanelStateMessage>
      )}
    </div>
  );
}

function ExplorerNavigationBar(props: {
  workspaceRoot: string;
  projectWorkspaceRoot: string | null;
  canNavigateBack: boolean;
  onNavigateBack: () => void;
  onNavigateUp: (() => void) | null;
  onResetRoot: (() => void) | null;
}) {
  const folderName = folderNameOfWorkspaceRoot(props.workspaceRoot);
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border/55 bg-muted/15 px-2 py-1">
      <IconButton
        label="Back to previous folder"
        tooltip="Back to previous folder"
        tooltipSide="bottom"
        size="icon-xs"
        variant="chrome"
        aria-disabled={!props.canNavigateBack || undefined}
        className={cn(
          "shrink-0 text-muted-foreground hover:text-foreground",
          !props.canNavigateBack && "cursor-default opacity-45 hover:text-muted-foreground",
        )}
        onClick={() => {
          if (props.canNavigateBack) props.onNavigateBack();
        }}
      >
        <ArrowLeftIcon className="size-3.5" />
      </IconButton>
      <IconButton
        label="Up to parent folder (..)"
        tooltip={
          props.onNavigateUp
            ? `Up to parent folder (${parentWorkspaceRoot(props.workspaceRoot) ?? ".."})`
            : "Already at filesystem root"
        }
        tooltipSide="bottom"
        size="icon-xs"
        variant="chrome"
        aria-disabled={!props.onNavigateUp || undefined}
        className={cn(
          "shrink-0 text-muted-foreground hover:text-foreground",
          !props.onNavigateUp && "cursor-default opacity-45 hover:text-muted-foreground",
        )}
        onClick={() => {
          props.onNavigateUp?.();
        }}
      >
        <ArrowUpIcon className="size-3.5" />
      </IconButton>
      <div
        className="flex min-w-0 flex-1 items-center gap-1.5 px-1 text-ui-xs text-muted-foreground"
        title={props.workspaceRoot}
      >
        <FolderIcon className="size-3.5 shrink-0 opacity-75" />
        <span className="min-w-0 truncate font-medium text-foreground/90">{folderName}</span>
      </div>
      {props.onResetRoot &&
      props.projectWorkspaceRoot &&
      props.projectWorkspaceRoot !== props.workspaceRoot ? (
        <IconButton
          label="Return to project workspace root"
          tooltip={`Return to project root (${folderNameOfWorkspaceRoot(props.projectWorkspaceRoot)})`}
          tooltipSide="bottom"
          size="icon-xs"
          variant="chrome"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={props.onResetRoot}
        >
          <RotateCcwIcon className="size-3" />
        </IconButton>
      ) : null}
    </div>
  );
}

function ExplorerUploadProgressBar(props: { workspaceRoot: string | null }) {
  const progress = useWorkspaceUploadProgress(props.workspaceRoot);
  if (!progress) return null;
  const currentIndex = Math.min(progress.completedFiles + 1, progress.totalFiles);
  return (
    <div
      className="shrink-0 border-b border-border/65 bg-info/8 px-2.5 py-1.5"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-2 text-ui-xs">
        <span className="min-w-0 truncate font-medium text-foreground">
          Uploading {progress.currentFileName}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {currentIndex}/{progress.totalFiles} ({progress.percent}%)
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-border/60">
        <div
          className="h-full rounded-full bg-info transition-all duration-150"
          style={{ width: `${Math.max(4, progress.percent)}%` }}
        />
      </div>
    </div>
  );
}

export interface ExplorerLocalRootState {
  readonly baseRoot: string | null;
  readonly activeRoot: string | null;
  readonly history: readonly string[];
  readonly expandedDirectoriesByRoot: ReadonlyMap<string, ReadonlySet<string>>;
}

const EMPTY_LOCAL_ROOT_STATE: Omit<ExplorerLocalRootState, "baseRoot"> = {
  activeRoot: null,
  history: [],
  expandedDirectoriesByRoot: EMPTY_EXPANDED_DIRECTORIES_BY_ROOT,
};

export function makeEmptyLocalRootState(baseRoot: string | null): ExplorerLocalRootState {
  return { baseRoot, ...EMPTY_LOCAL_ROOT_STATE };
}

export function ensureLocalRootState(
  state: ExplorerLocalRootState,
  workspaceRoot: string | null,
): ExplorerLocalRootState {
  return state.baseRoot === workspaceRoot ? state : makeEmptyLocalRootState(workspaceRoot);
}

export function navigateLocalRootState(
  state: ExplorerLocalRootState,
  workspaceRoot: string | null,
  nextRoot: string,
): ExplorerLocalRootState {
  const base = ensureLocalRootState(state, workspaceRoot);
  const currentRoot = base.activeRoot ?? workspaceRoot;
  if (!currentRoot || nextRoot === currentRoot) return base;
  return {
    baseRoot: workspaceRoot,
    activeRoot:
      workspaceRoot !== null && localPathsEqual(nextRoot, workspaceRoot) ? null : nextRoot,
    history: [...base.history, currentRoot],
    expandedDirectoriesByRoot: base.expandedDirectoriesByRoot,
  };
}

export function navigateBackLocalRootState(
  state: ExplorerLocalRootState,
  workspaceRoot: string | null,
): ExplorerLocalRootState {
  const base = ensureLocalRootState(state, workspaceRoot);
  if (base.history.length === 0) return base;
  const prev = base.history[base.history.length - 1] ?? null;
  return {
    baseRoot: workspaceRoot,
    activeRoot:
      prev === null || (workspaceRoot !== null && localPathsEqual(prev, workspaceRoot))
        ? null
        : prev,
    history: base.history.slice(0, -1),
    expandedDirectoriesByRoot: base.expandedDirectoriesByRoot,
  };
}

export function resetLocalRootState(
  state: ExplorerLocalRootState,
  workspaceRoot: string | null,
): ExplorerLocalRootState {
  const base = ensureLocalRootState(state, workspaceRoot);
  if (base.activeRoot === null && base.history.length === 0) {
    return base;
  }
  return {
    baseRoot: workspaceRoot,
    activeRoot: null,
    history: [],
    expandedDirectoriesByRoot: base.expandedDirectoriesByRoot,
  };
}

export function toggleLocalRootExpandedDirectory(
  state: ExplorerLocalRootState,
  workspaceRoot: string | null,
  activeRoot: string,
  directoryPath: string,
): ExplorerLocalRootState {
  const base = ensureLocalRootState(state, workspaceRoot);
  const nextExpanded = new Set(
    base.expandedDirectoriesByRoot.get(activeRoot) ?? EMPTY_EXPANDED_DIRECTORIES,
  );
  if (nextExpanded.has(directoryPath)) {
    nextExpanded.delete(directoryPath);
  } else {
    nextExpanded.add(directoryPath);
  }
  const nextMap = new Map(base.expandedDirectoriesByRoot);
  nextMap.set(activeRoot, nextExpanded);
  return { ...base, expandedDirectoriesByRoot: nextMap };
}

function useExplorerLocalRoot(input: {
  readonly workspaceRoot: string | null;
  readonly projectWorkspaceRoot?: string | null | undefined;
  readonly selectedFilePath: string | null;
  readonly expandedDirectories: ReadonlySet<string>;
  readonly restrictSelectionToBaseRoot?: boolean | undefined;
  readonly onSelectFile: (path: string) => void;
  readonly onToggleDirectory: (path: string) => void;
  readonly onReferenceInChat: ((reference: ChatFileReference) => void) | undefined;
  readonly canNavigateBack?: boolean | undefined;
  readonly onNavigateRoot?: ((nextRoot: string) => void) | undefined;
  readonly onNavigateBack?: (() => void) | undefined;
  readonly onResetRoot?: (() => void) | undefined;
}) {
  const [localRootState, setLocalRootState] = useState<ExplorerLocalRootState>(() =>
    makeEmptyLocalRootState(input.workspaceRoot),
  );
  const usesExternalNavigation = input.onNavigateRoot !== undefined;
  const projectRoot = input.projectWorkspaceRoot ?? input.workspaceRoot;
  const effectiveLocalState = ensureLocalRootState(localRootState, input.workspaceRoot);
  const effectiveWorkspaceRoot = usesExternalNavigation
    ? input.workspaceRoot
    : (effectiveLocalState.activeRoot ?? input.workspaceRoot);
  const isNavigatedAwayFromBase =
    effectiveWorkspaceRoot !== null &&
    projectRoot !== null &&
    !localPathsEqual(effectiveWorkspaceRoot, projectRoot);
  const isLocalNavigatedAwayFromBase = !usesExternalNavigation && isNavigatedAwayFromBase;

  const navigateRoot = (nextRoot: string) => {
    if (!effectiveWorkspaceRoot || nextRoot === effectiveWorkspaceRoot) return;
    if (input.onNavigateRoot) {
      input.onNavigateRoot(nextRoot);
      return;
    }
    setLocalRootState((current) => navigateLocalRootState(current, input.workspaceRoot, nextRoot));
  };

  const navigateBack = () => {
    if (input.onNavigateBack) {
      input.onNavigateBack();
      return;
    }
    if (effectiveLocalState.history.length === 0) return;
    setLocalRootState((current) => navigateBackLocalRootState(current, input.workspaceRoot));
  };

  const resetRoot = () => {
    if (input.onResetRoot) {
      input.onResetRoot();
      return;
    }
    setLocalRootState((current) => resetLocalRootState(current, input.workspaceRoot));
  };

  const effectiveSelectedFilePath = isLocalNavigatedAwayFromBase
    ? resolveSelectedFilePathForActiveRoot(
        input.selectedFilePath,
        effectiveWorkspaceRoot,
        projectRoot,
      )
    : input.selectedFilePath;
  const effectiveExpandedDirectories =
    isLocalNavigatedAwayFromBase && effectiveWorkspaceRoot
      ? (effectiveLocalState.expandedDirectoriesByRoot.get(effectiveWorkspaceRoot) ??
        EMPTY_EXPANDED_DIRECTORIES)
      : input.expandedDirectories;
  const handleSelectFile = isLocalNavigatedAwayFromBase
    ? (path: string) => {
        if (input.restrictSelectionToBaseRoot) {
          const selectablePath = resolveSelectablePathForBaseRoot(
            path,
            effectiveWorkspaceRoot,
            projectRoot,
          );
          if (selectablePath !== null) {
            input.onSelectFile(selectablePath);
          }
          return;
        }
        input.onSelectFile(
          resolveExplorerPathForBaseRoot(path, effectiveWorkspaceRoot, projectRoot),
        );
      }
    : input.onSelectFile;
  const handleToggleDirectory =
    isLocalNavigatedAwayFromBase && effectiveWorkspaceRoot
      ? (path: string) => {
          const activeRoot = effectiveWorkspaceRoot;
          setLocalRootState((current) =>
            toggleLocalRootExpandedDirectory(current, input.workspaceRoot, activeRoot, path),
          );
        }
      : input.onToggleDirectory;
  const handleReferenceInChat = wrapReferenceInChatForActiveRoot(
    input.onReferenceInChat,
    effectiveWorkspaceRoot,
    projectRoot,
  );

  const canNavigateBack = usesExternalNavigation
    ? (input.canNavigateBack ?? false)
    : effectiveLocalState.history.length > 0;
  const parentRoot = effectiveWorkspaceRoot ? parentWorkspaceRoot(effectiveWorkspaceRoot) : null;
  const handleNavigateIntoDirectory = (relativePath: string) => {
    if (!effectiveWorkspaceRoot) return;
    navigateRoot(joinChildWorkspaceRoot(effectiveWorkspaceRoot, relativePath));
  };

  return {
    effectiveWorkspaceRoot,
    effectiveSelectedFilePath,
    effectiveExpandedDirectories,
    canNavigateBack,
    parentRoot,
    navigateRoot,
    navigateBack,
    resetRoot,
    handleNavigateIntoDirectory,
    handleSelectFile,
    handleToggleDirectory,
    handleReferenceInChat,
  };
}

export function WorkspaceFilesSidebar(props: {
  workspaceRoot: string | null;
  selectedFilePath: string | null;
  expandedDirectories: ReadonlySet<string>;
  containerClassName?: string;
  onSelectFile: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  onReferenceInChat: ((reference: ChatFileReference) => void) | undefined;
}) {
  const {
    effectiveWorkspaceRoot,
    effectiveSelectedFilePath,
    effectiveExpandedDirectories,
    canNavigateBack,
    parentRoot,
    navigateRoot,
    navigateBack,
    resetRoot,
    handleNavigateIntoDirectory,
    handleSelectFile,
    handleToggleDirectory,
    handleReferenceInChat,
  } = useExplorerLocalRoot({
    ...props,
    restrictSelectionToBaseRoot: true,
  });

  const prefetchEntry = useExplorerEntryPrefetch(effectiveWorkspaceRoot);
  const entryActions = useExplorerEntryActions({
    workspaceRoot: effectiveWorkspaceRoot,
    onReferenceInChat: handleReferenceInChat,
    onSelectFile: handleSelectFile,
    selectedFilePath: effectiveSelectedFilePath,
    onNavigateIntoDirectory: handleNavigateIntoDirectory,
  });
  const handleListKeyDown = useExplorerListNavigation();
  return (
    <aside
      className={props.containerClassName ?? EXPLORER_SIDEBAR_CONTAINER_CLASS}
      onKeyDown={handleListKeyDown}
    >
      {effectiveWorkspaceRoot ? (
        <ExplorerNavigationBar
          workspaceRoot={effectiveWorkspaceRoot}
          projectWorkspaceRoot={props.workspaceRoot}
          canNavigateBack={canNavigateBack}
          onNavigateBack={navigateBack}
          onNavigateUp={parentRoot ? () => navigateRoot(parentRoot) : null}
          onResetRoot={resetRoot}
        />
      ) : null}
      <ExplorerUploadProgressBar workspaceRoot={effectiveWorkspaceRoot} />
      <WorkspaceFilesTreeBody
        workspaceRoot={effectiveWorkspaceRoot}
        selectedFilePath={effectiveSelectedFilePath}
        expandedDirectories={effectiveExpandedDirectories}
        onSelectFile={handleSelectFile}
        onToggleDirectory={handleToggleDirectory}
        onNavigateUp={parentRoot ? () => navigateRoot(parentRoot) : undefined}
        onNavigateIntoDirectory={handleNavigateIntoDirectory}
        onPrefetchEntry={prefetchEntry}
        onEntryContextMenu={entryActions.openEntryMenu}
        onRootContextMenu={entryActions.openRootMenu}
        selection={entryActions.selection}
        onMoveEntries={entryActions.moveEntries}
      />
      {entryActions.dialog}
    </aside>
  );
}

function WorkspaceSearchResultRow(props: {
  entry: ProjectEntry;
  selected: boolean;
  onSelectFile: (path: string) => void;
  onPrefetchEntry: (entry: Pick<ProjectFileSystemEntry, "path" | "kind">) => void;
  onEntryContextMenu: (path: string, position: { x: number; y: number }) => void;
}) {
  const { entry, onEntryContextMenu, onPrefetchEntry, onSelectFile } = props;
  const { dir, name } = splitRepoRelativePath(entry.path);
  const handlePrefetch = () => {
    onPrefetchEntry(entry);
  };

  return (
    <button
      {...EXPLORER_ROW_PROPS}
      type="button"
      className={fileRowClassName(props.selected, "h-8 px-2")}
      title={entry.path}
      draggable
      onDragStart={(event) => {
        setFileReferenceDragData(event.dataTransfer, entry.path);
      }}
      onClick={() => onSelectFile(entry.path)}
      onPointerEnter={handlePrefetch}
      onFocus={handlePrefetch}
      onContextMenu={(event) => {
        event.preventDefault();
        onEntryContextMenu(entry.path, { x: event.clientX, y: event.clientY });
      }}
    >
      <FileEntryIcon pathValue={entry.path} kind="file" className="size-3.5 shrink-0 opacity-75" />
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
        <span className="shrink-0 truncate font-medium">{name}</span>
        {dir ? (
          <span className="min-w-0 truncate text-ui-sm text-muted-foreground/55">{dir}</span>
        ) : null}
      </div>
    </button>
  );
}

interface WorkspaceFileSearchState {
  // Trimmed live input — drives the "is the box empty?" decision (tree vs results).
  inputQuery: string;
  fileMatches: ReadonlyArray<ProjectEntry>;
  searchResultsPending: boolean;
  searchResultsCurrent: boolean;
  isFetching: boolean;
  error: Error | null;
  truncated: boolean;
}

// Fuzzy file-name search shared by the standalone search sidebar and the
// combined explorer sidebar: debounce keystrokes, then expose the matches plus
// the freshness flags both surfaces need to gate selection on stale results.
function useWorkspaceFileSearch(
  workspaceRoot: string | null,
  query: string,
): WorkspaceFileSearchState {
  const [debouncedQuery] = useDebouncedValue(query, {
    wait: EXPLORER_SEARCH_QUERY_DEBOUNCE_MS,
  });
  const inputQuery = query.trim();
  const trimmedQuery = debouncedQuery.trim();
  const hostId = useHostId();
  const entriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      hostId,
      cwd: workspaceRoot,
      query: trimmedQuery,
      kind: "file",
      limit: EXPLORER_SEARCH_RESULTS_LIMIT,
    }),
  );
  // Results are tied to the debounced query. While the user is ahead of that
  // query, keep old results non-selectable so Enter cannot open a stale match.
  const searchResultsPending = inputQuery !== trimmedQuery || entriesQuery.isPlaceholderData;
  const searchResultsCurrent = !searchResultsPending;
  const fileMatches = searchResultsCurrent
    ? (entriesQuery.data?.entries ?? EMPTY_WORKSPACE_SEARCH_FILE_MATCHES)
    : EMPTY_WORKSPACE_SEARCH_FILE_MATCHES;
  return {
    inputQuery,
    fileMatches,
    searchResultsPending,
    searchResultsCurrent,
    isFetching: entriesQuery.isFetching,
    error: searchResultsCurrent ? entriesQuery.error : null,
    truncated: entriesQuery.data?.truncated ?? false,
  };
}

// Search-box header: a fixed, full-width input that selects the top match on
// Enter and clears (returning to the tree, in the combined sidebar) on Escape.
function WorkspaceSearchInputHeader(props: {
  query: string;
  search: WorkspaceFileSearchState;
  autoFocus?: boolean;
  /** Controls beside the search box (Download, Refresh). */
  trailing?: ReactNode;
  onQueryChange: (query: string) => void;
  onSelectFile: (path: string) => void;
}) {
  const { onQueryChange, onSelectFile, query, search } = props;
  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (!search.searchResultsCurrent) {
        return;
      }
      const topMatch = search.fileMatches[0];
      if (topMatch) {
        onSelectFile(topMatch.path);
      }
      return;
    }
    if (event.key === "Escape" && query.length > 0) {
      event.stopPropagation();
      onQueryChange("");
    }
  };

  return (
    <div
      className={cn(
        "shrink-0 border-b border-border/65 p-2",
        props.trailing && "flex items-center gap-1.5",
      )}
    >
      <SearchInput
        value={query}
        autoFocus={props.autoFocus}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        placeholder="Search files..."
        aria-label="Search files"
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleInputKeyDown}
      />
      {props.trailing}
    </div>
  );
}

// Saves the selected files and folders (or the entire currently viewed folder when nothing
// is selected) as a file or .zip archive.
function ExplorerDownloadButton(props: {
  targets: readonly ExplorerSelectableEntry[];
  onDownload: () => void;
}) {
  const [first] = props.targets;
  const disabled = first === undefined;
  const isCurrentFolderArchive =
    props.targets.length === 1 && first !== undefined && (first.path === "." || first.path === "");
  const label = disabled
    ? "Select files to download"
    : isCurrentFolderArchive
      ? "Download current folder as ZIP"
      : props.targets.length === 1
        ? first.kind === "directory"
          ? "Download selected folder as ZIP"
          : "Download selected file"
        : `Download ${props.targets.length} selected ${props.targets.some((entry) => entry.kind === "directory") ? "items" : "files"}`;
  return (
    <IconButton
      label={label}
      tooltip={label}
      tooltipSide="bottom"
      aria-disabled={disabled || undefined}
      className={cn(
        "shrink-0 text-muted-foreground hover:text-foreground",
        disabled && "cursor-default opacity-64 hover:text-muted-foreground",
      )}
      onClick={() => {
        if (!disabled) props.onDownload();
      }}
    >
      <DownloadIcon className="size-3.5" />
    </IconButton>
  );
}

// Lists or hides `.git`, `.saint*` and build-cache folders; remembered on this device.
function ExplorerShowHiddenButton() {
  const [showHidden, setShowHidden] = useExplorerShowHidden();
  return (
    <IconButton
      label={showHidden ? "Hide hidden items" : "Show hidden items"}
      tooltip={
        showHidden ? "Hide .git, .saint and build folders" : "Show .git, .saint and build folders"
      }
      tooltipSide="bottom"
      aria-pressed={showHidden}
      className={cn(
        "shrink-0 hover:text-foreground",
        showHidden ? "text-foreground" : "text-muted-foreground",
      )}
      onClick={() => setShowHidden(!showHidden)}
    >
      <EyeIcon className="size-3.5" />
    </IconButton>
  );
}

// Dynamically invalidates and refetches every folder listing, file search index, and open file
// of the workspace on the host the Explorer shows so newly created folders/files appear immediately.
function ExplorerRefreshButton(props: { workspaceRoot: string }) {
  const queryClient = useQueryClient();
  const hostId = useHostId();
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await invalidateExplorerDirectories(queryClient, props.workspaceRoot, hostId);
      await queryClient.refetchQueries({
        predicate: ({ queryKey }) =>
          queryKey[0] === "projects" && queryKey[2] === props.workspaceRoot,
      });
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <IconButton
      label="Refresh files"
      tooltip="Refresh files and folders from disk"
      tooltipSide="bottom"
      className="shrink-0 text-muted-foreground hover:text-foreground"
      onClick={() => void handleRefresh()}
    >
      <RefreshCwIcon className={cn("size-3.5", isRefreshing && "animate-spin")} />
    </IconButton>
  );
}

// Scrollable search-results body (matches list + truncation hint). Callers only
// mount it once the query is non-empty, so the empty-query state lives outside.
function WorkspaceSearchResultsBody(props: {
  workspaceRoot: string | null;
  search: WorkspaceFileSearchState;
  selectedFilePath: string | null;
  onSelectFile: (path: string) => void;
  onPrefetchEntry: (entry: Pick<ProjectFileSystemEntry, "path" | "kind">) => void;
  onEntryContextMenu: (path: string, position: { x: number; y: number }) => void;
}) {
  const { fileMatches } = props.search;
  return (
    <>
      <div
        className={cn(
          "min-h-0 flex-1 overflow-auto px-1 py-1",
          fileMatches.length === 0 && "flex flex-col",
        )}
      >
        {!props.workspaceRoot ? (
          <PanelStateMessage density="compact" fill="flex">
            <p>No workspace.</p>
          </PanelStateMessage>
        ) : props.search.searchResultsCurrent && props.search.error ? (
          <PanelStateMessage density="compact" fill="flex">
            <p className="text-destructive/85">
              {props.search.error instanceof Error
                ? props.search.error.message
                : "Could not search files."}
            </p>
          </PanelStateMessage>
        ) : fileMatches.length === 0 ? (
          props.search.searchResultsPending || props.search.isFetching ? (
            <ExplorerLoadingRows depth={0} />
          ) : (
            <PanelStateMessage density="compact" fill="flex">
              <p>No matching files.</p>
            </PanelStateMessage>
          )
        ) : (
          fileMatches.map((entry) => (
            <WorkspaceSearchResultRow
              key={entry.path}
              entry={entry}
              selected={entry.path === props.selectedFilePath}
              onSelectFile={props.onSelectFile}
              onPrefetchEntry={props.onPrefetchEntry}
              onEntryContextMenu={props.onEntryContextMenu}
            />
          ))
        )}
      </div>
      {fileMatches.length > 0 && props.search.truncated ? (
        <p className="shrink-0 border-t border-border/45 px-3 py-1.5 text-ui-xs text-muted-foreground/70">
          Showing the top matches. Refine the search to narrow them down.
        </p>
      ) : null}
    </>
  );
}

export function WorkspaceSearchSidebar(props: {
  workspaceRoot: string | null;
  query: string;
  onQueryChange: (query: string) => void;
  selectedFilePath: string | null;
  containerClassName?: string;
  onSelectFile: (path: string) => void;
  onReferenceInChat: ((reference: ChatFileReference) => void) | undefined;
}) {
  const prefetchEntry = useExplorerEntryPrefetch(props.workspaceRoot);
  const handleEntryContextMenu = useResultEntryContextMenu(
    props.onReferenceInChat,
    props.workspaceRoot,
  );
  const handleListKeyDown = useExplorerListNavigation();
  const search = useWorkspaceFileSearch(props.workspaceRoot, props.query);

  return (
    <aside
      className={props.containerClassName ?? EXPLORER_SIDEBAR_CONTAINER_CLASS}
      onKeyDown={handleListKeyDown}
    >
      <WorkspaceSearchInputHeader
        query={props.query}
        search={search}
        autoFocus
        onQueryChange={props.onQueryChange}
        onSelectFile={props.onSelectFile}
      />
      {search.inputQuery.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col px-1 py-1">
          <PanelStateMessage density="compact" fill="flex">
            <p>Search files by name or path.</p>
          </PanelStateMessage>
        </div>
      ) : (
        <WorkspaceSearchResultsBody
          workspaceRoot={props.workspaceRoot}
          search={search}
          selectedFilePath={props.selectedFilePath}
          onSelectFile={props.onSelectFile}
          onPrefetchEntry={prefetchEntry}
          onEntryContextMenu={handleEntryContextMenu}
        />
      )}
    </aside>
  );
}

// Combined explorer: one panel with a fixed search box on top that shows the
// full file tree while empty and switches to fuzzy file-name results as soon as
// the user types — no separate Files/Search activity rail needed.
export function WorkspaceExplorerSidebar(props: {
  workspaceRoot: string | null;
  /** Original project workspace root, when `workspaceRoot` has been navigated elsewhere. */
  projectWorkspaceRoot?: string | null;
  canNavigateBack?: boolean;
  onNavigateRoot?: (nextRoot: string) => void;
  onNavigateBack?: () => void;
  onResetRoot?: () => void;
  selectedFilePath: string | null;
  expandedDirectories: ReadonlySet<string>;
  query: string;
  onQueryChange: (query: string) => void;
  containerClassName?: string;
  onSelectFile: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  onReferenceInChat: ((reference: ChatFileReference) => void) | undefined;
}) {
  const {
    effectiveWorkspaceRoot,
    effectiveSelectedFilePath,
    effectiveExpandedDirectories,
    canNavigateBack,
    parentRoot,
    navigateRoot,
    navigateBack,
    resetRoot,
    handleNavigateIntoDirectory,
    handleSelectFile,
    handleToggleDirectory,
    handleReferenceInChat,
  } = useExplorerLocalRoot(props);
  const projectRoot = props.projectWorkspaceRoot ?? props.workspaceRoot;

  const prefetchEntry = useExplorerEntryPrefetch(effectiveWorkspaceRoot);
  const entryActions = useExplorerEntryActions({
    workspaceRoot: effectiveWorkspaceRoot,
    onReferenceInChat: handleReferenceInChat,
    onSelectFile: handleSelectFile,
    selectedFilePath: effectiveSelectedFilePath,
    onNavigateIntoDirectory: handleNavigateIntoDirectory,
  });
  const { downloadSelection } = entryActions;
  const handleResultEntryContextMenu = useResultEntryContextMenu(
    handleReferenceInChat,
    effectiveWorkspaceRoot,
  );
  const handleListKeyDown = useExplorerListNavigation();
  const search = useWorkspaceFileSearch(effectiveWorkspaceRoot, props.query);

  return (
    <aside
      className={props.containerClassName ?? EXPLORER_SIDEBAR_CONTAINER_CLASS}
      onKeyDown={handleListKeyDown}
    >
      <WorkspaceSearchInputHeader
        query={props.query}
        search={search}
        trailing={
          <>
            {downloadSelection ? (
              <ExplorerDownloadButton
                targets={downloadSelection.targets}
                onDownload={downloadSelection.download}
              />
            ) : null}
            {effectiveWorkspaceRoot ? <ExplorerShowHiddenButton /> : null}
            {effectiveWorkspaceRoot ? (
              <ExplorerRefreshButton workspaceRoot={effectiveWorkspaceRoot} />
            ) : null}
          </>
        }
        onQueryChange={props.onQueryChange}
        onSelectFile={handleSelectFile}
      />
      {effectiveWorkspaceRoot ? (
        <ExplorerNavigationBar
          workspaceRoot={effectiveWorkspaceRoot}
          projectWorkspaceRoot={projectRoot}
          canNavigateBack={canNavigateBack}
          onNavigateBack={navigateBack}
          onNavigateUp={parentRoot ? () => navigateRoot(parentRoot) : null}
          onResetRoot={resetRoot}
        />
      ) : null}
      <ExplorerUploadProgressBar workspaceRoot={effectiveWorkspaceRoot} />
      {search.inputQuery.length === 0 ? (
        <WorkspaceFilesTreeBody
          workspaceRoot={effectiveWorkspaceRoot}
          selectedFilePath={effectiveSelectedFilePath}
          expandedDirectories={effectiveExpandedDirectories}
          onSelectFile={handleSelectFile}
          onToggleDirectory={handleToggleDirectory}
          onNavigateUp={parentRoot ? () => navigateRoot(parentRoot) : undefined}
          onNavigateIntoDirectory={handleNavigateIntoDirectory}
          onPrefetchEntry={prefetchEntry}
          onEntryContextMenu={entryActions.openEntryMenu}
          onRootContextMenu={entryActions.openRootMenu}
          selection={entryActions.selection}
          onMoveEntries={entryActions.moveEntries}
        />
      ) : (
        <WorkspaceSearchResultsBody
          workspaceRoot={effectiveWorkspaceRoot}
          search={search}
          selectedFilePath={effectiveSelectedFilePath}
          onSelectFile={handleSelectFile}
          onPrefetchEntry={prefetchEntry}
          onEntryContextMenu={handleResultEntryContextMenu}
        />
      )}
      {entryActions.dialog}
    </aside>
  );
}

export function ExplorerActivityBarButton(props: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const button = (
    <button
      type="button"
      className={cn(
        "relative flex h-12 w-full cursor-pointer items-center justify-center text-muted-foreground/72 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground",
        props.active && "bg-[var(--color-background-button-secondary)] text-foreground",
      )}
      aria-label={props.label}
      aria-pressed={props.active}
      title={props.label}
      onClick={props.onClick}
    >
      <span
        className={cn(
          "absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-r-full bg-transparent",
          props.active && "bg-foreground/85",
        )}
        aria-hidden="true"
      />
      {props.children}
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup side="right">{props.label}</TooltipPopup>
    </Tooltip>
  );
}
