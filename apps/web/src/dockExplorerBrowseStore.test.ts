import { ThreadId } from "@saint/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { dropFileOnSplitZone } from "./editorViewState";
import {
  dockExplorerSplitLayout,
  EMPTY_DOCK_EXPLORER_BROWSE_STATE,
  selectDockExplorerBrowseState,
  useDockExplorerBrowseStore,
} from "./dockExplorerBrowseStore";

const threadA = ThreadId.makeUnsafe("thread-a");
const threadB = ThreadId.makeUnsafe("thread-b");

beforeEach(() => {
  useDockExplorerBrowseStore.setState({ browseStateByThreadId: {} });
});

describe("dockExplorerBrowseStore", () => {
  it("keeps each thread's browse state independent", () => {
    const store = useDockExplorerBrowseStore.getState();
    store.selectFile(threadA, "src/a.ts");
    store.expandDirectories(threadA, ["src"]);
    store.setSearchQuery(threadA, "read");

    store.selectFile(threadB, "docs/b.md");

    const stateA = selectDockExplorerBrowseState(threadA)(useDockExplorerBrowseStore.getState());
    const stateB = selectDockExplorerBrowseState(threadB)(useDockExplorerBrowseStore.getState());
    expect(stateA).toEqual({
      selectedFilePath: "src/a.ts",
      openFilePaths: ["src/a.ts"],
      expandedDirectories: new Set(["src"]),
      searchQuery: "read",
      activeRootPath: null,
      rootHistory: [],
      splitLayout: null,
    });
    expect(stateB).toEqual({
      selectedFilePath: "docs/b.md",
      openFilePaths: ["docs/b.md"],
      expandedDirectories: new Set(),
      searchQuery: "",
      activeRootPath: null,
      rootHistory: [],
      splitLayout: null,
    });
  });

  it("opens each selected file as a tab and closes to the neighbouring tab", () => {
    const store = useDockExplorerBrowseStore.getState();
    store.selectFile(threadA, "a.ts");
    store.selectFile(threadA, "b.ts");
    store.selectFile(threadA, "c.ts");
    store.selectFile(threadA, "b.ts");
    const read = () =>
      selectDockExplorerBrowseState(threadA)(useDockExplorerBrowseStore.getState());
    expect(read().openFilePaths).toEqual(["a.ts", "b.ts", "c.ts"]);
    store.closeFile(threadA, "b.ts");
    expect(read()).toMatchObject({ openFilePaths: ["a.ts", "c.ts"], selectedFilePath: "c.ts" });
    store.closeFile(threadA, "a.ts");
    expect(read()).toMatchObject({ openFilePaths: ["c.ts"], selectedFilePath: "c.ts" });
    store.closeFile(threadA, "c.ts");
    expect(read()).toMatchObject({ openFilePaths: [], selectedFilePath: null });
  });

  it("toggles directories independently per thread", () => {
    const store = useDockExplorerBrowseStore.getState();
    store.toggleDirectory(threadA, "src");
    store.toggleDirectory(threadA, "src/inner");
    store.toggleDirectory(threadA, "src");

    expect(
      selectDockExplorerBrowseState(threadA)(useDockExplorerBrowseStore.getState())
        .expandedDirectories,
    ).toEqual(new Set(["src/inner"]));
  });

  it("returns the shared empty snapshot for unvisited threads", () => {
    const state = useDockExplorerBrowseStore.getState();
    expect(selectDockExplorerBrowseState(threadA)(state)).toBe(EMPTY_DOCK_EXPLORER_BROWSE_STATE);
  });

  it("does not write store entries for no-op updates", () => {
    const store = useDockExplorerBrowseStore.getState();
    store.setSearchQuery(threadA, "");
    store.selectFile(threadA, null);
    store.expandDirectories(threadA, []);

    expect(useDockExplorerBrowseStore.getState().browseStateByThreadId).toEqual({});
  });

  it("splits the viewer and mirrors the active group into the open tabs", () => {
    const store = useDockExplorerBrowseStore.getState();
    store.selectFile(threadA, "a.ts");
    store.selectFile(threadA, "b.ts");
    store.updateSplitLayout(threadA, (layout) =>
      dropFileOnSplitZone(layout, "group-1", "right", "b.ts", "group-1"),
    );
    const read = () =>
      selectDockExplorerBrowseState(threadA)(useDockExplorerBrowseStore.getState());

    expect(dockExplorerSplitLayout(read()).groups).toHaveLength(2);
    expect(read()).toMatchObject({ openFilePaths: ["b.ts"], selectedFilePath: "b.ts" });

    // Closing the last tab of the split group collapses back to one group.
    store.closeFile(threadA, "b.ts");
    expect(read()).toMatchObject({
      splitLayout: null,
      openFilePaths: ["a.ts"],
      selectedFilePath: "a.ts",
    });
  });
});
