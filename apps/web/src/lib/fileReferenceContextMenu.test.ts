// FILE: fileReferenceContextMenu.test.ts
// Purpose: Verifies file-reference menu labels and desktop reveal/copy actions.
// Layer: Web UI helper tests

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  clicked: null as string | null,
  copyText: vi.fn(),
  showContextMenu: vi.fn(),
  showInFolder: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("~/hooks/useCopyToClipboard", () => ({
  copyTextToClipboard: harness.copyText,
}));

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({
    contextMenu: { show: harness.showContextMenu },
    shell: { showInFolder: harness.showInFolder },
  }),
}));

vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: harness.toast },
}));

import { showFileReferenceContextMenu } from "./fileReferenceContextMenu";

beforeEach(() => {
  vi.stubGlobal("window", { desktopBridge: {} });
  vi.stubGlobal("navigator", { platform: "Win32" });
  harness.clicked = null;
  harness.copyText.mockReset();
  harness.showContextMenu.mockReset();
  harness.showInFolder.mockReset();
  harness.toast.mockReset();
  harness.showContextMenu.mockImplementation(async () => harness.clicked);
  harness.copyText.mockResolvedValue(undefined);
  harness.showInFolder.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("showFileReferenceContextMenu", () => {
  it("offers reveal before copy when an absolute reveal path is available", async () => {
    await showFileReferenceContextMenu({
      path: "/repo/output/video.mp4",
      revealPath: "/repo/output/video.mp4",
      position: { x: 12, y: 34 },
      onReferenceInChat: undefined,
    });

    expect(harness.showContextMenu).toHaveBeenCalledWith(
      [
        { id: "reveal-in-folder", label: "Open in Explorer" },
        { id: "copy-path", label: "Copy path" },
      ],
      { x: 12, y: 34 },
    );
  });

  it("hides the desktop-only reveal action in the browser", async () => {
    vi.stubGlobal("window", {});

    await showFileReferenceContextMenu({
      path: "/repo/output/video.mp4",
      revealPath: "/repo/output/video.mp4",
      position: { x: 12, y: 34 },
      onReferenceInChat: undefined,
    });

    expect(harness.showContextMenu).toHaveBeenCalledWith(
      [{ id: "copy-path", label: "Copy path" }],
      { x: 12, y: 34 },
    );
  });

  it("reveals the requested file through the desktop shell", async () => {
    harness.clicked = "reveal-in-folder";

    await showFileReferenceContextMenu({
      path: "/repo/output/video.mp4",
      revealPath: "/repo/output/video.mp4",
      position: { x: 12, y: 34 },
      onReferenceInChat: undefined,
    });

    expect(harness.showInFolder).toHaveBeenCalledWith("/repo/output/video.mp4");
    expect(harness.copyText).not.toHaveBeenCalled();
  });

  it("reports a stale file without leaking the shell rejection", async () => {
    harness.clicked = "reveal-in-folder";
    harness.showInFolder.mockRejectedValue(new Error("Folder not found: /repo/output/video.mp4"));

    await expect(
      showFileReferenceContextMenu({
        path: "/repo/output/video.mp4",
        revealPath: "/repo/output/video.mp4",
        position: { x: 12, y: 34 },
        onReferenceInChat: undefined,
      }),
    ).resolves.toBeUndefined();

    expect(harness.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Unable to reveal file",
      description: "Folder not found: /repo/output/video.mp4",
    });
  });

  it("copies the displayed filesystem path with the shared clipboard fallback", async () => {
    harness.clicked = "copy-path";

    await showFileReferenceContextMenu({
      path: "/repo/output/video.mp4",
      revealPath: "/repo/output/video.mp4",
      position: { x: 12, y: 34 },
      onReferenceInChat: undefined,
    });

    expect(harness.copyText).toHaveBeenCalledWith("/repo/output/video.mp4");
    expect(harness.showInFolder).not.toHaveBeenCalled();
  });

  it("groups relative and full path copies and copies the workspace-joined path", async () => {
    harness.clicked = "copy-full-path";

    await showFileReferenceContextMenu({
      path: "src/app.ts",
      position: { x: 1, y: 2 },
      onReferenceInChat: undefined,
      workspaceRoot: "/home/pt/repo/",
    });

    expect(harness.showContextMenu).toHaveBeenCalledWith(
      [
        {
          id: "copy-path-group",
          label: "Copy path",
          children: [
            { id: "copy-path", label: "Relative path" },
            { id: "copy-full-path", label: "Full path" },
          ],
        },
      ],
      { x: 1, y: 2 },
    );
    expect(harness.copyText).toHaveBeenCalledWith("/home/pt/repo/src/app.ts");
  });

  it("adds explorer actions and runs the chosen one", async () => {
    const actions = { onNewFile: vi.fn(), onNewFolder: vi.fn(), onDelete: vi.fn() };
    harness.clicked = "delete";

    await showFileReferenceContextMenu({
      path: "src",
      position: { x: 1, y: 2 },
      onReferenceInChat: undefined,
      explorerActions: actions,
    });

    const items = harness.showContextMenu.mock.calls[0]?.[0] as Array<{ id: string }>;
    expect(items.map((item) => item.id)).toEqual(["copy-path", "new-file", "new-folder", "delete"]);
    expect(actions.onDelete).toHaveBeenCalledOnce();
    expect(actions.onNewFile).not.toHaveBeenCalled();
  });
});
