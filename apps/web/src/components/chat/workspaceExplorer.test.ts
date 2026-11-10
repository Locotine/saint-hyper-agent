import { describe, expect, it, vi } from "vitest";

import {
  makeEmptyLocalRootState,
  navigateBackLocalRootState,
  navigateLocalRootState,
  resetLocalRootState,
  resolveExplorerPathForBaseRoot,
  resolveSelectablePathForBaseRoot,
  resolveSelectedFilePathForActiveRoot,
  toggleLocalRootExpandedDirectory,
  wrapReferenceInChatForActiveRoot,
} from "./workspaceExplorer";

describe("workspaceExplorer", () => {
  it("resolves in-root selection, out-of-root selection no-op, active-root highlight paths, and chat references", () => {
    // Navigating into a child folder keeps paths workspace-relative for the consumer.
    expect(resolveExplorerPathForBaseRoot("src/App.tsx", "/work/repo/apps/web", "/work/repo")).toBe(
      "apps/web/src/App.tsx",
    );
    expect(
      resolveSelectablePathForBaseRoot("src/App.tsx", "/work/repo/apps/web", "/work/repo"),
    ).toBe("apps/web/src/App.tsx");
    expect(
      resolveSelectedFilePathForActiveRoot(
        "apps/web/src/App.tsx",
        "/work/repo/apps/web",
        "/work/repo",
      ),
    ).toBe("src/App.tsx");

    // Navigating up (`..`) to a parent folder resolves sibling files as absolute paths
    // for chat references, returns null (no-op) for out-of-root selection in the editor
    // sidebar, and maps files inside the original workspace back to workspace-relative paths.
    expect(resolveExplorerPathForBaseRoot("other-repo/README.md", "/work", "/work/repo")).toBe(
      "/work/other-repo/README.md",
    );
    expect(
      resolveSelectablePathForBaseRoot("other-repo/README.md", "/work", "/work/repo"),
    ).toBeNull();
    expect(resolveExplorerPathForBaseRoot("repo/package.json", "/work", "/work/repo")).toBe(
      "package.json",
    );
    expect(resolveSelectablePathForBaseRoot("repo/package.json", "/work", "/work/repo")).toBe(
      "package.json",
    );
    expect(
      resolveSelectedFilePathForActiveRoot("/work/other-repo/README.md", "/work", "/work/repo"),
    ).toBe("other-repo/README.md");

    // wrapReferenceInChatForActiveRoot maps active-root relative paths to base-relative
    // when inside the project root and absolute when outside.
    const onRef = vi.fn();
    const wrappedChild = wrapReferenceInChatForActiveRoot(
      onRef,
      "/work/repo/apps/web",
      "/work/repo",
    );
    wrappedChild?.({ path: "src/App.tsx", startLine: 10 });
    expect(onRef).toHaveBeenLastCalledWith({ path: "apps/web/src/App.tsx", startLine: 10 });

    const wrappedSibling = wrapReferenceInChatForActiveRoot(onRef, "/work", "/work/repo");
    wrappedSibling?.({ path: "other-repo/README.md" });
    expect(onRef).toHaveBeenLastCalledWith({ path: "/work/other-repo/README.md" });
  });

  it("preserves expanded directories per root across navigation, back, and reset", () => {
    const baseRoot = "/work/repo";
    let state = makeEmptyLocalRootState(baseRoot);

    // Navigate up to `/work` and expand a directory there.
    state = navigateLocalRootState(state, baseRoot, "/work");
    expect(state.activeRoot).toBe("/work");
    expect(state.history).toEqual(["/work/repo"]);
    state = toggleLocalRootExpandedDirectory(state, baseRoot, "/work", "other-repo/src");
    expect(state.expandedDirectoriesByRoot.get("/work")).toEqual(new Set(["other-repo/src"]));

    // Navigate into `/work/other-repo` and expand a different directory.
    state = navigateLocalRootState(state, baseRoot, "/work/other-repo");
    expect(state.activeRoot).toBe("/work/other-repo");
    expect(state.expandedDirectoriesByRoot.get("/work/other-repo")).toBeUndefined();
    state = toggleLocalRootExpandedDirectory(state, baseRoot, "/work/other-repo", "packages");
    expect(state.expandedDirectoriesByRoot.get("/work/other-repo")).toEqual(new Set(["packages"]));

    // Navigate back to `/work`: expanded folders for `/work` are preserved.
    state = navigateBackLocalRootState(state, baseRoot);
    expect(state.activeRoot).toBe("/work");
    expect(state.expandedDirectoriesByRoot.get("/work")).toEqual(new Set(["other-repo/src"]));

    // Reset back to base root and navigate to `/work` again: still preserved.
    state = resetLocalRootState(state, baseRoot);
    expect(state.activeRoot).toBeNull();
    state = navigateLocalRootState(state, baseRoot, "/work");
    expect(state.expandedDirectoriesByRoot.get("/work")).toEqual(new Set(["other-repo/src"]));
  });
});
