import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadWorkspaceFiles, resolveWorkspaceDownloadRequests } from "./workspaceDownloads";

const BACKEND_WS_URL = "ws://127.0.0.1:4100/?token=main-token";
const ROUTE = "http://127.0.0.1:4100/api/workspace/download";

function item(cwd: string, path: string, fileName = "a.txt") {
  return { cwd, path, fileName };
}

describe("resolveWorkspaceDownloadRequests", () => {
  it("builds the URL from the host's own origin and token", () => {
    const requests = resolveWorkspaceDownloadRequests(
      [item("/home/pt/repo", "docs/a b.txt")],
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

  it("refuses names that are paths, empty parts, non-loopback hosts and non-lists", () => {
    expect(
      resolveWorkspaceDownloadRequests([item("/r", "a", "../a.txt")], BACKEND_WS_URL),
    ).toBeNull();
    expect(resolveWorkspaceDownloadRequests([item("", "a")], BACKEND_WS_URL)).toBeNull();
    expect(resolveWorkspaceDownloadRequests([item("/r", "")], BACKEND_WS_URL)).toBeNull();
    expect(resolveWorkspaceDownloadRequests([item("/r", "a")], null)).toBeNull();
    expect(
      resolveWorkspaceDownloadRequests([item("/r", "a")], "ws://10.0.0.2:4100/?token=t"),
    ).toBeNull();
    expect(
      resolveWorkspaceDownloadRequests([item("/r", "a")], "wss://127.0.0.1:4100/?token=t"),
    ).toBeNull();
    expect(resolveWorkspaceDownloadRequests("x", BACKEND_WS_URL)).toBeNull();
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
