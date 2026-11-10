// FILE: EditorWorkspaceView.test.tsx
// Purpose: Guards the editor-style shell layout around file/diff sidebars.
// Layer: Component rendering tests
// Depends on: EditorWorkspaceView and React server rendering.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import type { ComponentProps, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { EditorWorkspaceView } from "./EditorWorkspaceView";
import { WorkspaceSearchSidebar } from "./chat/workspaceExplorer";
import {
  closeFileInSplitGroup,
  createInitialEditorSplitLayout,
  dropFileOnSplitZone,
  moveTabBetweenSplitGroups,
  readEditorViewState,
  resizeSplitGroups,
  resolveSplitDropZoneFromPoint,
  storeEditorSplitLayout,
} from "../editorViewState";
import { projectQueryKeys } from "../lib/projectReactQuery";
import { SidebarProvider } from "./ui/sidebar";

function renderToStaticMarkup(node: ReactNode, queryClient = new QueryClient()) {
  return renderMarkup(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
}

function makeEditorBaseProps(): ComponentProps<typeof EditorWorkspaceView> {
  return {
    workspaceRoot: "/Users/tester/project",
    projectName: "project",
    selectedFilePath: null,
    expandedDirectories: new Set(),
    centerMode: "file",
    diffFiles: [],
    selectedDiffFilePath: null,
    diffPanel: <div>Diff panel</div>,
    chatPanel: <div>Chat panel</div>,
    onSelectFile: vi.fn(),
    onSelectDiffFile: vi.fn(),
    onToggleDirectory: vi.fn(),
    onCenterModeChange: vi.fn(),
    editFilePath: null,
    editDiffBaseRev: null,
    onEditFile: vi.fn(),
    onCloseEdit: vi.fn(),
    onExitEditorView: vi.fn(),
  };
}

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
}));

vi.mock("~/hooks/useDesktopTopBarGutter", () => ({
  useDesktopTopBarTrafficLightGutterClassName: () => "traffic-light-gutter",
  useDesktopTopBarWindowControlsGutterClassName: () => "windows-caption-gutter",
}));

describe("EditorWorkspaceView", () => {
  it("shows skeleton rows instead of the empty message while the diff loads", () => {
    const markup = renderToStaticMarkup(
      <SidebarProvider>
        <EditorWorkspaceView {...makeEditorBaseProps()} centerMode="diff" diffFilesLoading={true} />
      </SidebarProvider>,
    );

    expect(markup).toContain('aria-label="Loading changed files..."');
    expect(markup).not.toContain("No files in this diff.");
  });

  it("keeps the diff panel mounted but hidden while browsing files", () => {
    const markup = renderToStaticMarkup(
      <SidebarProvider>
        <EditorWorkspaceView
          {...makeEditorBaseProps()}
          workspaceRoot={null}
          diffPanel={<div>Diff panel body</div>}
        />
      </SidebarProvider>,
    );

    expect(markup).toContain("Diff panel body");
    const diffWrapperIndex = markup.indexOf("Diff panel body");
    const hiddenIndex = markup.lastIndexOf("hidden", diffWrapperIndex);
    expect(hiddenIndex).toBeGreaterThan(-1);
  });

  it("renders image files through the local image preview instead of text preview", () => {
    const markup = renderToStaticMarkup(
      <EditorWorkspaceView {...makeEditorBaseProps()} selectedFilePath="assets/screenshot.png" />,
    );

    expect(markup).toContain("local-image-preview");
    expect(markup).toContain(
      "/api/local-image?path=assets%2Fscreenshot.png&amp;cwd=%2FUsers%2Ftester%2Fproject",
    );
    expect(markup).not.toContain("editor-file-viewer__plain");
    expect(markup).not.toContain("editor-file-viewer__highlight");
  });

  it("renders PDF files through the in-app PDF viewer instead of the text preview", () => {
    const markup = renderToStaticMarkup(
      <EditorWorkspaceView {...makeEditorBaseProps()} selectedFilePath="docs/spec.pdf" />,
    );

    // The custom viewer renders its own surface (here the initial loading state
    // since document fetch runs in an effect) rather than the browser iframe or
    // the text preview.
    expect(markup).toContain('aria-label="Loading PDF..."');
    expect(markup).not.toContain("<iframe");
    expect(markup).not.toContain("editor-file-viewer__plain");
    expect(markup).not.toContain("editor-file-viewer__highlight");
  });

  it("renders scratch-workspace PDF previews without an attached workspace", () => {
    const markup = renderToStaticMarkup(
      <EditorWorkspaceView
        {...makeEditorBaseProps()}
        workspaceRoot={null}
        selectedFilePath="/tmp/saint-codex-workspaces/thread-1/report.pdf"
      />,
    );

    expect(markup).toContain('aria-label="Loading PDF..."');
    expect(markup).not.toContain("No workspace is attached");
  });

  it("renders scratch-workspace image previews without an attached workspace", () => {
    const markup = renderToStaticMarkup(
      <EditorWorkspaceView
        {...makeEditorBaseProps()}
        workspaceRoot={null}
        selectedFilePath="/tmp/saint-codex-workspaces/thread-1/shot.png"
      />,
    );

    expect(markup).toContain("local-image-preview");
    expect(markup).toContain(
      "/api/local-image?path=%2Ftmp%2Fsaint-codex-workspaces%2Fthread-1%2Fshot.png",
    );
    expect(markup).not.toContain("No workspace is attached");
    expect(markup).not.toContain("cwd=");
  });

  it("renders absolute local image previews without an attached workspace", () => {
    const markup = renderToStaticMarkup(
      <EditorWorkspaceView
        {...makeEditorBaseProps()}
        workspaceRoot={null}
        selectedFilePath="/Users/tester/Downloads/shot.png"
      />,
    );

    expect(markup).toContain('aria-label="Loading file..."');
    expect(markup).not.toContain("/api/local-image?path=%2FUsers%2Ftester%2FDownloads%2Fshot.png");
    expect(markup).not.toContain("No workspace is attached");
    expect(markup).not.toContain("cwd=");
  });

  it("lists only matching files from the workspace search results", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      projectQueryKeys.searchEntries("/Users/tester/project", "editor", 80, "file"),
      {
        entries: [{ path: "apps/web/src/components/EditorWorkspaceView.tsx", kind: "file" }],
        truncated: false,
      },
    );
    const markup = renderToStaticMarkup(
      <WorkspaceSearchSidebar
        workspaceRoot="/Users/tester/project"
        query="editor"
        onQueryChange={vi.fn()}
        selectedFilePath="apps/web/src/components/EditorWorkspaceView.tsx"
        onSelectFile={vi.fn()}
        onReferenceInChat={undefined}
      />,
      queryClient,
    );

    expect(markup).toContain('title="apps/web/src/components/EditorWorkspaceView.tsx"');
    expect(markup).toContain("EditorWorkspaceView.tsx");
    expect(markup).not.toContain("No matching files.");
  });

  it("exposes toolbar toggles for hiding the left file explorer and chat pane while keeping chat mounted", () => {
    const storage = new Map<string, string>();
    const prevWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
        },
      },
    });
    try {
      const defaultMarkup = renderToStaticMarkup(
        <SidebarProvider>
          <EditorWorkspaceView {...makeEditorBaseProps()} />
        </SidebarProvider>,
      );
      expect(defaultMarkup).toContain('aria-label="Hide file explorer"');
      expect(defaultMarkup).toContain('aria-label="Hide chat panel"');

      storage.set("saint.editor.sidebarVisible", "false");
      storage.set("saint.editor.chatPaneVisible", "false");
      const hiddenMarkup = renderToStaticMarkup(
        <SidebarProvider>
          <EditorWorkspaceView {...makeEditorBaseProps()} chatPanel={<div>Persistent chat</div>} />
        </SidebarProvider>,
      );
      expect(hiddenMarkup).toContain('aria-label="Show file explorer"');
      expect(hiddenMarkup).toContain('aria-label="Show chat panel"');
      expect(hiddenMarkup).toContain("Persistent chat");
      const chatIndex = hiddenMarkup.indexOf("Persistent chat");
      const asideIndex = hiddenMarkup.lastIndexOf("<aside", chatIndex);
      expect(hiddenMarkup.slice(asideIndex, chatIndex)).toContain("hidden");
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: prevWindow,
      });
    }
  });

  it("supports VS Code-style split editor groups, tab moves, group auto-close, divider resize, and per-thread persistence", () => {
    const storage = new Map<string, string>();
    const prevWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
        },
      },
    });
    try {
      let layout = createInitialEditorSplitLayout("src/a.ts");
      layout = dropFileOnSplitZone(layout, "group-1", "right", "src/b.ts");
      expect(layout.groups).toHaveLength(2);
      expect(layout.direction).toBe("horizontal");
      expect(layout.groups[0]?.selectedFilePath).toBe("src/a.ts");
      expect(layout.groups[1]?.selectedFilePath).toBe("src/b.ts");

      // Resize divider between group 0 and group 1
      layout = resizeSplitGroups(layout, 0, 15);
      expect(layout.sizes[0]).toBeCloseTo(65, 1);
      expect(layout.sizes[1]).toBeCloseTo(35, 1);

      // Persist per thread in saint.editor.viewStateByThreadId and render EditorWorkspaceView
      storeEditorSplitLayout("thread-split-1", layout);
      const restored = readEditorViewState("thread-split-1")?.splitLayout;
      expect(restored?.groups).toHaveLength(2);

      const markup = renderToStaticMarkup(
        <SidebarProvider>
          <EditorWorkspaceView
            {...makeEditorBaseProps()}
            threadId="thread-split-1"
            selectedFilePath="src/b.ts"
          />
        </SidebarProvider>,
      );
      expect(markup).toContain('data-editor-split-group="group-1"');
      expect(markup).toContain('data-editor-split-group="group-2"');
      expect(markup).toContain('aria-label="Resize split editor group"');

      // Moving the last tab out of group-2 closes group-2 automatically
      const merged = moveTabBetweenSplitGroups(layout, "group-2", "src/b.ts", "group-1");
      expect(merged.groups).toHaveLength(1);
      expect(merged.groups[0]?.openFilePaths).toEqual(["src/a.ts", "src/b.ts"]);

      // Closing a tab in a multi-group layout when it's the last tab closes that group
      const afterClose = closeFileInSplitGroup(layout, "group-2", "src/b.ts");
      expect(afterClose.groups).toHaveLength(1);
      expect(afterClose.groups[0]?.id).toBe("group-1");

      // Hit-testing drop zones on an editor group rect
      const rect = { left: 0, top: 0, width: 400, height: 300 };
      expect(resolveSplitDropZoneFromPoint(rect, 20, 150)).toBe("left");
      expect(resolveSplitDropZoneFromPoint(rect, 380, 150)).toBe("right");
      expect(resolveSplitDropZoneFromPoint(rect, 200, 20)).toBe("top");
      expect(resolveSplitDropZoneFromPoint(rect, 200, 285)).toBe("bottom");
      expect(resolveSplitDropZoneFromPoint(rect, 200, 150)).toBe("center");
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: prevWindow,
      });
    }
  });
});
