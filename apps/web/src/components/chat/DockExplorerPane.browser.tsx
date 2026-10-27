import "../../index.css";

import type { NativeApi, ProjectFileSystemEntry } from "@saint/contracts";
import { ThreadId } from "@saint/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useDockExplorerBrowseStore } from "../../dockExplorerBrowseStore";
import {
  requestExplorerReveal,
  useExplorerRevealRequestStore,
} from "../../explorerRevealRequestStore";
import { resolveWorkspaceDirectoryOpenTarget } from "../../lib/workspaceFileOpener";
import { projectListDirectoriesQueryOptions } from "../../lib/projectReactQuery";
import { isMacPlatform } from "../../lib/utils";
import { DockExplorerPane } from "./DockExplorerPane";

vi.mock("../WorkspaceFilePreview", () => ({
  WorkspaceFilePreview: (props: { filePath: string | null }) => (
    <div data-testid="file-preview">{props.filePath}</div>
  ),
}));

const threadId = ThreadId.makeUnsafe("directory-reveal-test");
let restoreNativeApi: (() => void) | undefined;

afterEach(() => {
  restoreNativeApi?.();
  useExplorerRevealRequestStore.setState({ requestsByThreadId: {} });
  useDockExplorerBrowseStore.setState({ browseStateByThreadId: {} });
});

function directory(path: string): ProjectFileSystemEntry {
  return { path, name: path.split("/").at(-1)!, kind: "directory", hasChildren: true };
}

async function renderExplorer(
  cwd: string,
  listDirectories: NativeApi["projects"]["listDirectories"],
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  paneThreadId: ThreadId = threadId,
  extraApi: { readonly projects?: object; readonly [key: string]: unknown } = {},
) {
  const previous = Object.getOwnPropertyDescriptor(window, "nativeApi");
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: {
      ...extraApi,
      projects: {
        listDirectories,
        searchEntries: vi.fn().mockResolvedValue({ entries: [], truncated: false }),
        ...extraApi.projects,
      },
    },
  });
  restoreNativeApi = () => {
    if (previous) Object.defineProperty(window, "nativeApi", previous);
    else Reflect.deleteProperty(window, "nativeApi");
  };
  return render(
    <QueryClientProvider client={queryClient}>
      <DockExplorerPane threadId={paneThreadId} workspaceRoot={cwd} isVisible />
    </QueryClientProvider>,
  );
}

it("reveals Windows links using actual entry casing and still collapses manually", async () => {
  const cwd = "c:/repo/app";
  const listDirectories = vi
    .fn<NativeApi["projects"]["listDirectories"]>()
    .mockImplementation(async ({ relativePath }) => ({
      entries:
        relativePath === "src"
          ? [directory("src/inner")]
          : relativePath === "src/inner"
            ? [{ path: "src/inner/readme.md", name: "readme.md", kind: "file" }]
            : [directory("src")],
    }));
  await renderExplorer(cwd, listDirectories);
  requestExplorerReveal(
    threadId,
    resolveWorkspaceDirectoryOpenTarget("C:\\Repo\\App\\SRC\\INNER\\", cwd)!,
  );

  await expect.element(page.getByTitle("src/inner/readme.md", { exact: true })).toBeVisible();
  expect(listDirectories).toHaveBeenCalledWith({ cwd, relativePath: "src", includeFiles: true });
  await page.getByTitle("src", { exact: true }).click();
  await expect
    .element(page.getByTitle("src", { exact: true }))
    .toHaveAttribute("aria-expanded", "false");
});

it("keeps POSIX directory reveals case-sensitive", async () => {
  const cwd = "/repo/app";
  await renderExplorer(
    cwd,
    vi
      .fn<NativeApi["projects"]["listDirectories"]>()
      .mockImplementation(async ({ relativePath }) => ({
        entries: relativePath
          ? [{ path: `${relativePath}/readme.md`, name: "readme.md", kind: "file" }]
          : [directory("src"), directory("SRC")],
      })),
  );
  requestExplorerReveal(threadId, resolveWorkspaceDirectoryOpenTarget("/repo/app/SRC/", cwd)!);

  await expect.element(page.getByTitle("SRC/readme.md", { exact: true })).toBeVisible();
  await expect
    .element(page.getByTitle("src", { exact: true }))
    .toHaveAttribute("aria-expanded", "false");
});

it("clears an existing search when the workspace root is revealed", async () => {
  const cwd = "c:/repo/app";
  await renderExplorer(cwd, vi.fn().mockResolvedValue({ entries: [directory("src")] }));
  const search = page.getByPlaceholder("Search files");
  await search.fill("missing");
  await expect.element(page.getByText("No matching files.")).toBeVisible();

  requestExplorerReveal(threadId, resolveWorkspaceDirectoryOpenTarget("C:\\Repo\\App", cwd)!);
  await expect.element(search).toHaveValue("");
  await expect.element(page.getByTitle("src", { exact: true })).toBeVisible();
});

it("ignores a pending directory reveal after a newer root request", async () => {
  const cwd = "c:/repo/app";
  let resolveListing!: (result: { entries: ProjectFileSystemEntry[] }) => void;
  const pending = new Promise<{ entries: ProjectFileSystemEntry[] }>((resolve) => {
    resolveListing = resolve;
  });
  const listDirectories = vi
    .fn<NativeApi["projects"]["listDirectories"]>()
    .mockReturnValue(pending);
  await renderExplorer(cwd, listDirectories);
  const search = page.getByPlaceholder("Search files");
  await search.fill("before first reveal");
  requestExplorerReveal(threadId, "SRC");
  await expect.element(search).toHaveValue("");
  await search.fill("before root reveal");
  requestExplorerReveal(threadId, "");
  await expect.element(search).toHaveValue("");
  resolveListing({ entries: [directory("src")] });

  await expect.element(page.getByTitle("src", { exact: true })).toBeVisible();
  await expect
    .element(page.getByTitle("src", { exact: true }))
    .toHaveAttribute("aria-expanded", "false");
});

it("refreshes an invalidated listing before resolving a Windows reveal", async () => {
  const cwd = "c:/repo/app";
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const childQuery = projectListDirectoriesQueryOptions({ cwd, relativePath: "src" });
  queryClient.setQueryData(childQuery.queryKey, { entries: [] });
  await queryClient.invalidateQueries({ queryKey: childQuery.queryKey, refetchType: "none" });
  const listDirectories = vi
    .fn<NativeApi["projects"]["listDirectories"]>()
    .mockImplementation(async ({ relativePath }) => ({
      entries:
        relativePath === "src"
          ? [directory("src/new")]
          : relativePath === "src/new"
            ? []
            : [directory("src")],
    }));
  await renderExplorer(cwd, listDirectories, queryClient);
  requestExplorerReveal(threadId, "SRC/NEW");

  await expect
    .element(page.getByTitle("src/new", { exact: true }))
    .toHaveAttribute("aria-expanded", "true");
  expect(listDirectories).toHaveBeenCalledWith({ cwd, relativePath: "src", includeFiles: true });
});

it("keeps the open file, expanded directories, and search query when the thread remounts", async () => {
  const cwd = "/repo/app";
  const listDirectories = vi
    .fn<NativeApi["projects"]["listDirectories"]>()
    .mockImplementation(async ({ relativePath }) => ({
      entries:
        relativePath === "src"
          ? [{ path: "src/readme.md", name: "readme.md", kind: "file" }]
          : [directory("src")],
    }));
  const first = await renderExplorer(cwd, listDirectories);
  await page.getByTitle("src", { exact: true }).click();
  await page.getByTitle("src/readme.md", { exact: true }).click();
  await expect.element(page.getByTestId("file-preview")).toHaveTextContent("src/readme.md");
  const search = page.getByPlaceholder("Search files");
  await search.fill("read");
  await expect.element(page.getByText("No matching files.")).toBeVisible();
  await first.unmount();

  // Another thread's pane mounts in between (the thread switch); its browse
  // state starts empty and must not see thread one's file.
  const other = await renderExplorer(
    cwd,
    listDirectories,
    undefined,
    ThreadId.makeUnsafe("other-thread"),
  );
  await expect
    .element(page.getByTitle("src", { exact: true }))
    .toHaveAttribute("aria-expanded", "false");
  await other.unmount();

  // Switching back remounts the first thread's pane with its browse state.
  await renderExplorer(cwd, listDirectories);
  await expect.element(page.getByTestId("file-preview")).toHaveTextContent("src/readme.md");
  await expect.element(page.getByPlaceholder("Search files")).toHaveValue("read");
  await page.getByPlaceholder("Search files").fill("");
  await expect
    .element(page.getByTitle("src", { exact: true }))
    .toHaveAttribute("aria-expanded", "true");
  await expect.element(page.getByTitle("src/readme.md", { exact: true })).toBeVisible();
});

function file(path: string): ProjectFileSystemEntry {
  return { path, name: path.split("/").at(-1)!, kind: "file" };
}

const toggleModifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";

function flatWorkspace() {
  return vi
    .fn<NativeApi["projects"]["listDirectories"]>()
    .mockImplementation(async ({ relativePath }) => ({
      entries: relativePath ? [] : [directory("docs"), file("a.txt"), file("b.txt"), file("c.txt")],
    }));
}

function selectedRowTitles() {
  return Array.from(document.querySelectorAll("[data-explorer-path][data-selected]"), (row) =>
    row.getAttribute("data-explorer-path"),
  );
}

it("multi-selects rows with Cmd/Ctrl- and Shift-click and clears them on Escape", async () => {
  await renderExplorer("/repo/app", flatWorkspace());
  await page.getByTitle("a.txt", { exact: true }).click();
  await expect.element(page.getByTestId("file-preview")).toHaveTextContent("a.txt");

  await page.getByTitle("c.txt", { exact: true }).click({ modifiers: ["Shift"] });
  await expect.poll(selectedRowTitles).toEqual(["a.txt", "b.txt", "c.txt"]);
  // Selecting does not open another file.
  await expect.element(page.getByTestId("file-preview")).toHaveTextContent("a.txt");

  await page.getByTitle("b.txt", { exact: true }).click({ modifiers: [toggleModifier] });
  await page.getByTitle("docs", { exact: true }).click({ modifiers: [toggleModifier] });
  await expect.poll(selectedRowTitles).toEqual(["docs", "a.txt", "c.txt"]);
  // A modifier click on a folder selects it without expanding it.
  await expect
    .element(page.getByTitle("docs", { exact: true }))
    .toHaveAttribute("aria-expanded", "false");

  await userEvent.keyboard("{Escape}");
  await expect.poll(selectedRowTitles).toEqual(["a.txt"]);
});

it("deletes a multi-selection after one confirmation", async () => {
  const contextMenu = vi.fn().mockResolvedValue("delete");
  const confirm = vi.fn().mockResolvedValue(true);
  const deleteEntry = vi
    .fn<NativeApi["projects"]["deleteEntry"]>()
    .mockImplementation(async ({ relativePath }) => ({ relativePath, kind: "file" }));
  await renderExplorer("/repo/app", flatWorkspace(), undefined, threadId, {
    contextMenu: { show: contextMenu },
    dialogs: { confirm },
    projects: { deleteEntry },
  });
  await page.getByTitle("b.txt", { exact: true }).click({ modifiers: [toggleModifier] });
  await page.getByTitle("c.txt", { exact: true }).click({ modifiers: [toggleModifier] });
  await page.getByTitle("c.txt", { exact: true }).click({ button: "right" });

  await expect.poll(() => deleteEntry.mock.calls.length).toBe(2);
  const items = contextMenu.mock.calls[0]?.[0] as Array<{ id: string; label: string }>;
  expect(items.find((item) => item.id === "delete")?.label).toBe("Delete 2 items…");
  // Local windows have nothing to download.
  expect(items.some((item) => item.id === "download")).toBe(false);
  expect(confirm).toHaveBeenCalledOnce();
  expect(confirm.mock.calls[0]?.[0]).toContain("Delete 2 items?");
  expect(deleteEntry.mock.calls.map(([input]) => input.relativePath)).toEqual(["b.txt", "c.txt"]);
});

it("moves dragged rows into the folder they are dropped on", async () => {
  const moveEntry = vi
    .fn<NativeApi["projects"]["moveEntry"]>()
    .mockImplementation(async ({ relativePath, destinationDirectory }) => ({
      relativePath: `${destinationDirectory}/${relativePath}`,
      kind: "file",
    }));
  await renderExplorer("/repo/app", flatWorkspace(), undefined, threadId, {
    projects: { moveEntry },
  });
  await page.getByTitle("a.txt", { exact: true }).click({ modifiers: [toggleModifier] });
  await page.getByTitle("b.txt", { exact: true }).click({ modifiers: [toggleModifier] });
  await page.getByTitle("b.txt", { exact: true }).dropTo(page.getByTitle("docs", { exact: true }));

  await expect.poll(() => moveEntry.mock.calls.length).toBe(2);
  expect(moveEntry.mock.calls.map(([input]) => input)).toEqual([
    { cwd: "/repo/app", relativePath: "a.txt", destinationDirectory: "docs" },
    { cwd: "/repo/app", relativePath: "b.txt", destinationDirectory: "docs" },
  ]);
  // Dropping a row where it already is moves nothing.
  await page.getByTitle("c.txt", { exact: true }).dropTo(page.getByTitle("a.txt", { exact: true }));
  expect(moveEntry).toHaveBeenCalledTimes(2);
});

it("downloads the selected files from a remote window, skipping folders", async () => {
  const downloadFiles = vi.fn().mockResolvedValue({ canceled: true, saved: [], failures: [] });
  const contextMenu = vi.fn().mockResolvedValue(null);
  const previousBridge = Object.getOwnPropertyDescriptor(window, "desktopBridge");
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { remoteWindow: { host: "devbox", editors: [], providers: [], downloadFiles } },
  });
  try {
    await renderExplorer("/repo/app", flatWorkspace(), undefined, threadId, {
      contextMenu: { show: contextMenu },
    });
    const button = page.getByRole("button", { name: "Select files to download" });
    await expect.element(button).toHaveAttribute("aria-disabled", "true");

    for (const title of ["a.txt", "b.txt", "docs"]) {
      await page.getByTitle(title, { exact: true }).click({ modifiers: [toggleModifier] });
    }
    await page.getByTitle("a.txt", { exact: true }).click({ button: "right" });
    await expect.poll(() => contextMenu.mock.calls.length).toBe(1);
    const items = contextMenu.mock.calls[0]?.[0] as Array<{ id: string; label: string }>;
    expect(items.find((item) => item.id === "download")?.label).toBe("Download 2 files");

    await page.getByRole("button", { name: "Download 2 selected files" }).click();
    await expect.poll(() => downloadFiles.mock.calls.length).toBe(1);
    const [request] = downloadFiles.mock.calls[0] as [
      { items: Array<{ url: string; fileName: string }> },
    ];
    const downloads = request.items;
    expect(downloads.map((item) => item.fileName)).toEqual(["a.txt", "b.txt"]);
    const url = new URL(downloads[0]!.url);
    expect(url.pathname).toBe("/api/workspace/download");
    expect(url.searchParams.get("cwd")).toBe("/repo/app");
    expect(url.searchParams.get("path")).toBe("a.txt");
  } finally {
    if (previousBridge) Object.defineProperty(window, "desktopBridge", previousBridge);
    else Reflect.deleteProperty(window, "desktopBridge");
  }
});

it("selects a plain-clicked folder and deletes the selection with the platform key", async () => {
  const confirm = vi.fn().mockResolvedValue(true);
  const deleteEntry = vi
    .fn<NativeApi["projects"]["deleteEntry"]>()
    .mockImplementation(async ({ relativePath }) => ({ relativePath, kind: "file" }));
  await renderExplorer("/repo/app", flatWorkspace(), undefined, threadId, {
    dialogs: { confirm },
    projects: { deleteEntry },
  });
  await page.getByTitle("docs", { exact: true }).click();
  await expect.poll(selectedRowTitles).toEqual(["docs"]);
  await expect
    .element(page.getByTitle("docs", { exact: true }))
    .toHaveAttribute("aria-expanded", "true");

  await page.getByTitle("b.txt", { exact: true }).click({ modifiers: [toggleModifier] });
  await expect.poll(selectedRowTitles).toEqual(["docs", "b.txt"]);
  await userEvent.keyboard(toggleModifier === "Meta" ? "{Meta>}{Backspace}{/Meta}" : "{Delete}");

  await expect.poll(() => deleteEntry.mock.calls.length).toBe(2);
  expect(confirm.mock.calls[0]?.[0]).toContain("Delete 2 items?");
  expect(deleteEntry.mock.calls.map(([input]) => input.relativePath)).toEqual(["docs", "b.txt"]);
});

it("renames the focused row with F2, preselecting the name without its extension", async () => {
  const renameEntry = vi
    .fn<NativeApi["projects"]["renameEntry"]>()
    .mockImplementation(async ({ newName }) => ({ relativePath: newName, kind: "file" }));
  await renderExplorer("/repo/app", flatWorkspace(), undefined, threadId, {
    projects: { renameEntry },
  });
  await page.getByTitle("a.txt", { exact: true }).click();
  await expect.element(page.getByTestId("file-preview")).toHaveTextContent("a.txt");
  await userEvent.keyboard("{F2}");

  const input = page.getByRole("textbox", { name: "Rename" });
  await expect.element(input).toHaveValue("a.txt");
  await expect
    .poll(() => {
      const element = input.element() as HTMLInputElement;
      return [element.selectionStart, element.selectionEnd];
    })
    .toEqual([0, 1]);
  await userEvent.keyboard("renamed{Enter}");

  await expect.poll(() => renameEntry.mock.calls.length).toBe(1);
  expect(renameEntry).toHaveBeenCalledWith({
    cwd: "/repo/app",
    relativePath: "a.txt",
    newName: "renamed.txt",
  });
  // The preview follows the renamed file.
  await expect.element(page.getByTestId("file-preview")).toHaveTextContent("renamed.txt");
});

it("renames with Enter on macOS only; elsewhere Enter keeps opening the row", async () => {
  await renderExplorer("/repo/app", flatWorkspace(), undefined, threadId, {
    projects: { renameEntry: vi.fn() },
  });
  await expect.element(page.getByTitle("docs", { exact: true })).toBeVisible();
  (page.getByTitle("docs", { exact: true }).element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  if (toggleModifier === "Meta") {
    await expect.element(page.getByRole("textbox", { name: "Rename" })).toHaveValue("docs");
    await expect
      .element(page.getByTitle("docs", { exact: true }))
      .toHaveAttribute("aria-expanded", "false");
  } else {
    await expect
      .element(page.getByTitle("docs", { exact: true }))
      .toHaveAttribute("aria-expanded", "true");
  }
});

it("opens a collapsed folder held under a drag", async () => {
  await renderExplorer("/repo/app", flatWorkspace());
  await expect.element(page.getByTitle("a.txt", { exact: true })).toBeVisible();
  const source = page.getByTitle("a.txt", { exact: true }).element();
  const folderRow = page.getByTitle("docs", { exact: true }).element();
  const dataTransfer = new DataTransfer();
  source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
  folderRow.dispatchEvent(
    new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }),
  );
  await expect
    .element(page.getByTitle("docs", { exact: true }))
    .toHaveAttribute("aria-expanded", "false");
  await expect
    .element(page.getByTitle("docs", { exact: true }), { timeout: 2000 })
    .toHaveAttribute("aria-expanded", "true");
  source.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer }));
});
