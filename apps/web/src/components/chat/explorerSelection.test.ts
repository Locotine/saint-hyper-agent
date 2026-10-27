import { describe, expect, it } from "vitest";

import {
  EMPTY_EXPLORER_SELECTION,
  type ExplorerSelectableEntry,
  explorerActionTargets,
  explorerClickIntent,
  explorerMovableEntries,
  explorerRenameSelectionEnd,
  explorerTreeKeyAction,
  nextExplorerSelection,
  withoutNestedExplorerEntries,
} from "./explorerSelection";

const file = (path: string): ExplorerSelectableEntry => ({ path, kind: "file" });
const folder = (path: string): ExplorerSelectableEntry => ({ path, kind: "directory" });

// Display order of an expanded tree: docs/ (a.md, b.md), src/, z.txt.
const visible = [
  folder("docs"),
  file("docs/a.md"),
  file("docs/b.md"),
  folder("src"),
  file("z.txt"),
];

const click = (
  state: typeof EMPTY_EXPLORER_SELECTION,
  intent: "open" | "toggle" | "range",
  entry: ExplorerSelectableEntry,
  openFilePath: string | null = null,
) => nextExplorerSelection(state, { intent, entry, visibleEntries: visible, openFilePath });

describe("explorerClickIntent", () => {
  it("toggles with Cmd on macOS and Ctrl elsewhere, and ranges with Shift", () => {
    const keys = { metaKey: false, ctrlKey: false, shiftKey: false };
    expect(explorerClickIntent(keys, true)).toBe("open");
    expect(explorerClickIntent({ ...keys, metaKey: true }, true)).toBe("toggle");
    expect(explorerClickIntent({ ...keys, ctrlKey: true }, true)).toBe("open");
    expect(explorerClickIntent({ ...keys, ctrlKey: true }, false)).toBe("toggle");
    expect(explorerClickIntent({ ...keys, metaKey: true }, false)).toBe("open");
    expect(explorerClickIntent({ ...keys, shiftKey: true, metaKey: true }, true)).toBe("range");
  });
});

describe("nextExplorerSelection", () => {
  it("keeps a plain click a single selection and moves the anchor", () => {
    const state = click(
      { entries: [file("z.txt"), folder("src")], anchor: "src" },
      "open",
      file("docs/a.md"),
    );
    expect(state).toEqual({ entries: [], anchor: "docs/a.md" });
  });

  it("selects a plain-clicked folder on its own", () => {
    expect(click({ entries: [file("z.txt")], anchor: "z.txt" }, "open", folder("src"))).toEqual({
      entries: [folder("src")],
      anchor: "src",
    });
  });

  it("adds the open file first, then toggles rows in and out", () => {
    const added = click(EMPTY_EXPLORER_SELECTION, "toggle", file("z.txt"), "docs/a.md");
    expect(added).toEqual({ entries: [file("docs/a.md"), file("z.txt")], anchor: "z.txt" });
    const folderAdded = click(added, "toggle", folder("src"));
    expect(folderAdded.entries.map((entry) => entry.path)).toEqual(["docs/a.md", "z.txt", "src"]);
    expect(click(folderAdded, "toggle", file("docs/a.md")).entries.map((e) => e.path)).toEqual([
      "z.txt",
      "src",
    ]);
  });

  it("seeds from the last plain-clicked row, even a folder", () => {
    const anchored = click(EMPTY_EXPLORER_SELECTION, "open", folder("src"), "docs/a.md");
    expect(click(anchored, "toggle", file("z.txt"), "docs/a.md").entries).toEqual([
      folder("src"),
      file("z.txt"),
    ]);
  });

  it("selects the visible range from the anchor in either direction and keeps the anchor", () => {
    const anchored = click(EMPTY_EXPLORER_SELECTION, "open", file("docs/b.md"));
    const down = click(anchored, "range", file("z.txt"));
    expect(down).toEqual({
      entries: [file("docs/b.md"), folder("src"), file("z.txt")],
      anchor: "docs/b.md",
    });
    expect(click(down, "range", folder("docs")).entries).toEqual([
      folder("docs"),
      file("docs/a.md"),
      file("docs/b.md"),
    ]);
  });

  it("ranges from the open file, or selects just the row when the anchor is hidden", () => {
    expect(click(EMPTY_EXPLORER_SELECTION, "range", folder("src"), "docs/b.md").entries).toEqual([
      file("docs/b.md"),
      folder("src"),
    ]);
    expect(click({ entries: [], anchor: "collapsed/x.md" }, "range", folder("src"), null)).toEqual({
      entries: [folder("src")],
      anchor: "src",
    });
  });
});

describe("explorerActionTargets", () => {
  const selection = [file("z.txt"), folder("src")];

  it("acts on the selection when the clicked row is in it", () => {
    expect(explorerActionTargets(selection, folder("src"))).toBe(selection);
  });

  it("acts on the clicked row alone otherwise", () => {
    expect(explorerActionTargets(selection, file("docs/a.md"))).toEqual([file("docs/a.md")]);
    expect(explorerActionTargets([file("z.txt")], file("z.txt"))).toEqual([file("z.txt")]);
  });
});

describe("withoutNestedExplorerEntries", () => {
  it("drops entries inside a selected folder but not look-alike siblings", () => {
    expect(
      withoutNestedExplorerEntries([
        file("docs/a.md"),
        folder("docs"),
        file("docs-old/a.md"),
        file("z.txt"),
      ]),
    ).toEqual([folder("docs"), file("docs-old/a.md"), file("z.txt")]);
  });
});

describe("explorerMovableEntries", () => {
  it("skips entries already in the destination", () => {
    expect(explorerMovableEntries(["docs/a.md", "z.txt"], "docs")).toEqual(["z.txt"]);
    expect(explorerMovableEntries(["z.txt"], "")).toEqual([]);
  });

  it("never moves a folder into itself or one of its descendants", () => {
    expect(explorerMovableEntries(["docs"], "docs")).toEqual([]);
    expect(explorerMovableEntries(["docs", "z.txt"], "docs/specs")).toEqual(["z.txt"]);
    expect(explorerMovableEntries(["docs"], "docs-old")).toEqual(["docs"]);
  });

  it("moves a selected folder once, with its selected children inside it", () => {
    expect(explorerMovableEntries(["docs", "docs/a.md"], "src")).toEqual(["docs"]);
  });
});

const key = (
  name: string,
  modifiers: Partial<Record<"meta" | "ctrl" | "alt" | "shift", true>> = {},
) => ({
  key: name,
  metaKey: modifiers.meta ?? false,
  ctrlKey: modifiers.ctrl ?? false,
  altKey: modifiers.alt ?? false,
  shiftKey: modifiers.shift ?? false,
});

describe("explorerTreeKeyAction", () => {
  it("maps VS Code's macOS keys", () => {
    expect(explorerTreeKeyAction(key("Backspace", { meta: true }), true)).toBe("delete");
    expect(explorerTreeKeyAction(key("Backspace"), true)).toBeNull();
    expect(explorerTreeKeyAction(key("Delete"), true)).toBeNull();
    expect(explorerTreeKeyAction(key("Enter"), true)).toBe("rename");
    expect(explorerTreeKeyAction(key("Enter", { meta: true }), true)).toBeNull();
    expect(explorerTreeKeyAction(key("F2"), true)).toBe("rename");
    expect(explorerTreeKeyAction(key("Escape"), true)).toBe("clear");
  });

  it("maps VS Code's Windows and Linux keys", () => {
    expect(explorerTreeKeyAction(key("Delete"), false)).toBe("delete");
    expect(explorerTreeKeyAction(key("Delete", { ctrl: true }), false)).toBeNull();
    expect(explorerTreeKeyAction(key("Backspace", { meta: true }), false)).toBeNull();
    expect(explorerTreeKeyAction(key("F2"), false)).toBe("rename");
    // Enter keeps opening the row there.
    expect(explorerTreeKeyAction(key("Enter"), false)).toBeNull();
    expect(explorerTreeKeyAction(key("Escape"), false)).toBe("clear");
  });
});

describe("explorerRenameSelectionEnd", () => {
  it("selects a file's name without its last extension, and whole folder and dotfile names", () => {
    expect(explorerRenameSelectionEnd(file("src/app.test.ts"))).toBe("app.test".length);
    expect(explorerRenameSelectionEnd(file(".env"))).toBe(".env".length);
    expect(explorerRenameSelectionEnd(file("Makefile"))).toBe("Makefile".length);
    expect(explorerRenameSelectionEnd(folder("docs/v1.2"))).toBe("v1.2".length);
  });
});
