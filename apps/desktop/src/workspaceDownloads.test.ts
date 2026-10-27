import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadWorkspaceFiles, resolveWorkspaceDownloadRequests } from "./workspaceDownloads";

const BACKEND_WS_URL = "ws://127.0.0.1:4100/?token=main-token";
const ROUTE = "http://127.0.0.1:4100/api/workspace/download";

function item(url: string, fileName = "a.txt") {
  return { url, fileName };
}

describe("resolveWorkspaceDownloadRequests", () => {
  it("rebuilds the URL from the backend's own origin and token", () => {
    const requests = resolveWorkspaceDownloadRequests(
      {
        items: [
          item(`${ROUTE}?cwd=%2Fhome%2Fpt%2Frepo&path=docs%2Fa+b.txt&token=renderer&extra=1`),
        ],
      },
      BACKEND_WS_URL,
    );
    expect(requests).toHaveLength(1);
    const url = new URL(requests![0]!.url);
    expect(url.origin).toBe("http://127.0.0.1:4100");
    expect(url.pathname).toBe("/api/workspace/download");
    expect([...url.searchParams]).toEqual([
      ["cwd", "/home/pt/repo"],
      ["path", "docs/a b.txt"],
      ["token", "main-token"],
    ]);
  });

  it.each([
    ["another port", "http://127.0.0.1:4101/api/workspace/download?cwd=/r&path=a"],
    ["another host", "http://example.com:4100/api/workspace/download?cwd=/r&path=a"],
    ["another route", "http://127.0.0.1:4100/api/attachments/x?cwd=/r&path=a"],
    ["https", "https://127.0.0.1:4100/api/workspace/download?cwd=/r&path=a"],
    ["credentials", "http://u:p@127.0.0.1:4100/api/workspace/download?cwd=/r&path=a"],
    ["no path", "http://127.0.0.1:4100/api/workspace/download?cwd=/r"],
    ["not a URL", "file:///etc/passwd"],
  ])("refuses %s", (_label, url) => {
    expect(resolveWorkspaceDownloadRequests({ items: [item(url)] }, BACKEND_WS_URL)).toBeNull();
  });

  it("refuses file names that are paths and backends that are not loopback", () => {
    const url = `${ROUTE}?cwd=/r&path=a`;
    expect(
      resolveWorkspaceDownloadRequests({ items: [item(url, "../a.txt")] }, BACKEND_WS_URL),
    ).toBeNull();
    expect(resolveWorkspaceDownloadRequests({ items: [item(url)] }, null)).toBeNull();
    expect(
      resolveWorkspaceDownloadRequests(
        { items: [item("http://10.0.0.2:4100/api/workspace/download?cwd=/r&path=a")] },
        "ws://10.0.0.2:4100/?token=t",
      ),
    ).toBeNull();
    expect(resolveWorkspaceDownloadRequests({ items: "x" }, BACKEND_WS_URL)).toBeNull();
  });
});

describe("downloadWorkspaceFiles", () => {
  const directories: string[] = [];
  const makeDirectory = () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "saint-downloads-"));
    directories.push(directory);
    return directory;
  };
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      FS.rmSync(directory, { recursive: true, force: true });
    }
  });

  const fetchFrom = (files: Record<string, string>) =>
    vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).searchParams.get("path") ?? "";
      return path in files
        ? new Response(files[path])
        : Response.json({ error: `${path} no longer exists.` }, { status: 404 });
    }) as unknown as typeof fetch;

  it("saves into a folder without replacing taken names and reports failures", async () => {
    const directory = makeDirectory();
    FS.writeFileSync(Path.join(directory, "a.txt"), "existing");
    const result = await downloadWorkspaceFiles({
      requests: [
        { url: `${ROUTE}?cwd=/r&path=a.txt`, fileName: "a.txt" },
        { url: `${ROUTE}?cwd=/r&path=gone.txt`, fileName: "gone.txt" },
        { url: `${ROUTE}?cwd=/r&path=b.bin`, fileName: "b.bin" },
      ],
      destination: { kind: "directory", path: directory },
      fetch: fetchFrom({ "a.txt": "new", "b.bin": "bytes" }),
    });

    expect(result).toEqual({
      canceled: false,
      saved: [
        { fileName: "a.txt", path: Path.join(directory, "a (1).txt") },
        { fileName: "b.bin", path: Path.join(directory, "b.bin") },
      ],
      failures: [{ fileName: "gone.txt", message: "gone.txt no longer exists." }],
    });
    expect(FS.readFileSync(Path.join(directory, "a.txt"), "utf8")).toBe("existing");
    expect(FS.readFileSync(Path.join(directory, "a (1).txt"), "utf8")).toBe("new");
    expect(FS.existsSync(Path.join(directory, "gone.txt"))).toBe(false);
  });

  it("replaces the file chosen in a Save dialog and keeps it when the download fails", async () => {
    const directory = makeDirectory();
    const chosen = Path.join(directory, "report.pdf");
    FS.writeFileSync(chosen, "old");
    const failed = await downloadWorkspaceFiles({
      requests: [{ url: `${ROUTE}?cwd=/r&path=missing.pdf`, fileName: "missing.pdf" }],
      destination: { kind: "file", path: chosen },
      fetch: fetchFrom({}),
    });
    expect(failed.failures).toHaveLength(1);
    expect(FS.readFileSync(chosen, "utf8")).toBe("old");

    const saved = await downloadWorkspaceFiles({
      requests: [{ url: `${ROUTE}?cwd=/r&path=report.pdf`, fileName: "report.pdf" }],
      destination: { kind: "file", path: chosen },
      fetch: fetchFrom({ "report.pdf": "new" }),
    });
    expect(saved.saved).toEqual([{ fileName: "report.pdf", path: chosen }]);
    expect(FS.readFileSync(chosen, "utf8")).toBe("new");
    expect(FS.readdirSync(directory)).toEqual(["report.pdf"]);
  });
});
