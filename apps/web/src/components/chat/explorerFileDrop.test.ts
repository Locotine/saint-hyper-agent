import { LOCAL_HOST_ID, sshHostId } from "@saint/shared/hostId";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { explorerDropDirectoryFor, useExplorerFileDrop } from "./explorerFileDrop";

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  toast: vi.fn(),
  invalidate: vi.fn(() => Promise.resolve()),
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => [initial, vi.fn()],
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
}));
vi.mock("~/lib/workspaceUpload", () => ({ uploadFilesToWorkspace: mocks.upload }));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));

describe("explorerDropDirectoryFor", () => {
  it("drops onto a folder row into that folder", () => {
    expect(explorerDropDirectoryFor({ path: "docs/specs", kind: "directory" })).toBe("docs/specs");
  });

  it("drops onto a file row into its parent folder", () => {
    expect(explorerDropDirectoryFor({ path: "docs/specs/a.md", kind: "file" })).toBe("docs/specs");
    expect(explorerDropDirectoryFor({ path: "README.md", kind: "file" })).toBe("");
  });
});

function dropEvent(types: string[], data: Record<string, string> = {}, files: File[] = []) {
  const event = {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    target: { closest: () => ({ getAttribute: () => "docs" }) },
    currentTarget: { contains: () => false },
    relatedTarget: null,
    dataTransfer: {
      types,
      files,
      dropEffect: "none",
      getData: (type: string) => data[type] ?? "",
    },
  };
  return event as never as Parameters<
    NonNullable<ReturnType<typeof useExplorerFileDrop>["handlers"]["onDrop"]>
  >[0] &
    typeof event;
}

describe("useExplorerFileDrop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.upload.mockResolvedValue({ uploaded: ["docs/a.txt"], failures: [] });
  });

  it("uploads an OS file drop into the targeted folder on the Explorer's host", async () => {
    const hostId = sshHostId("a1b2c3d4");
    const onMove = vi.fn();
    const { handlers } = useExplorerFileDrop("/repo", onMove, hostId);
    const files = [{ name: "a.txt" } as File];

    const over = dropEvent(["Files"]);
    handlers.onDragOver!(over);
    expect(over.dataTransfer.dropEffect).toBe("copy");

    handlers.onDrop!(dropEvent(["Files"], {}, files));
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());

    expect(mocks.upload).toHaveBeenCalledWith({ cwd: "/repo", directory: "docs", files, hostId });
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Uploaded docs/a.txt" }),
    );
    expect(onMove).not.toHaveBeenCalled();
  });

  it("toasts each failed upload", async () => {
    mocks.upload.mockResolvedValue({
      uploaded: [],
      failures: [{ name: "b.txt", message: "Larger than 256MB." }],
    });
    const { handlers } = useExplorerFileDrop("/repo", vi.fn(), LOCAL_HOST_ID);

    handlers.onDrop!(dropEvent(["Files"], {}, [{ name: "b.txt" } as File]));
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());

    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", description: "Larger than 256MB." }),
    );
  });

  it("moves a row dragged inside the tree and never uploads", () => {
    const onMove = vi.fn();
    const { handlers } = useExplorerFileDrop("/repo", onMove, LOCAL_HOST_ID);
    const payload = JSON.stringify({ cwd: "/repo", paths: ["src/a.ts"] });

    handlers.onDrop!(
      dropEvent(["application/x-saint-explorer-entries", "Files"], {
        "application/x-saint-explorer-entries": payload,
      }),
    );

    expect(onMove).toHaveBeenCalledWith(["src/a.ts"], "docs");
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("leaves a row dragged out of the Explorer to the composer", () => {
    const { handlers } = useExplorerFileDrop("/repo", vi.fn(), LOCAL_HOST_ID);
    const event = dropEvent(["Files", "application/x-saint-file-reference"]);

    handlers.onDrop!(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("has no handlers without a workspace", () => {
    expect(useExplorerFileDrop(null, vi.fn(), LOCAL_HOST_ID).handlers).toEqual({});
  });
});
