import { LOCAL_HOST_ID, sshHostId } from "@saint/shared/hostId";
import { WORKSPACE_UPLOAD_MAX_BYTES } from "@saint/shared/binaryTransfer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { uploadFilesToWorkspace } from "./workspaceUpload";

const resolveHostHttpUrl = vi.hoisted(() =>
  vi.fn((hostId: string, path: string) => `${hostId}|${path}`),
);
vi.mock("./wsHttpUrl", () => ({ resolveHostHttpUrl }));

function file(name: string, size = 3): File {
  return { name, size } as File;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("uploadFilesToWorkspace", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resolveHostHttpUrl.mockClear();
  });

  it("posts each file to its host and collects the written paths", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ relativePath: "docs/a.txt" }))
      .mockResolvedValueOnce(jsonResponse({ relativePath: "docs/b (1).txt" }));
    vi.stubGlobal("fetch", fetchMock);
    const hostId = sshHostId("a1b2c3d4");

    const result = await uploadFilesToWorkspace({
      cwd: "/repo",
      directory: "docs",
      files: [file("a.txt"), file("b.txt")],
      hostId,
    });

    expect(result).toEqual({ uploaded: ["docs/a.txt", "docs/b (1).txt"], failures: [] });
    const [path] = resolveHostHttpUrl.mock.calls[0]!.slice(1) as [string];
    expect(resolveHostHttpUrl.mock.calls[0]![0]).toBe(hostId);
    expect(new URLSearchParams(path.split("?")[1]).get("directory")).toBe("docs");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "POST" });
  });

  it("skips files over the cap without sending them", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ relativePath: "ok.txt" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadFilesToWorkspace({
      cwd: "/repo",
      directory: null,
      files: [file("big.bin", WORKSPACE_UPLOAD_MAX_BYTES + 1), file("ok.txt")],
      hostId: LOCAL_HOST_ID,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.uploaded).toEqual(["ok.txt"]);
    expect(result.failures).toEqual([
      { name: "big.bin", message: expect.stringContaining("Larger than") },
    ]);
  });

  it("collects server errors and rejected fetches without stopping the rest", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ error: "No space left." }, 500))
        .mockRejectedValueOnce(new Error("network down"))
        .mockResolvedValueOnce(jsonResponse({ relativePath: "c.txt" })),
    );

    const result = await uploadFilesToWorkspace({
      cwd: "/repo",
      directory: null,
      files: [file("a.txt"), file("b.txt"), file("c.txt")],
      hostId: LOCAL_HOST_ID,
    });

    expect(result.uploaded).toEqual(["c.txt"]);
    expect(result.failures).toEqual([
      { name: "a.txt", message: "No space left." },
      { name: "b.txt", message: "network down" },
    ]);
  });
});
