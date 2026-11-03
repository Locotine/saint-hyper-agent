import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as Zlib from "node:zlib";

import { sha256Hex, templatesDigest, templatesFromArchive } from "@saint/shared/scannerRelease";
import type { ScannerPins } from "@saint/shared/scannerRelease";
import { afterEach, describe, expect, it } from "vitest";

import {
  installedTemplatesDir,
  installedToolDir,
  installNucleiTemplates,
  installTool,
  isOfficialDownloadUrl,
  downloadOfficial,
} from "./install.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const cache = async () => {
  const dir = await mkdtemp(path.join(os.homedir(), ".saint-install-test-"));
  dirs.push(dir);
  return dir;
};

/** A gzipped ustar of `files`, only as much of the format as the readers need. */
function tarGz(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512, 0);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.fill(0x20, 148, 156);
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Zlib.gzipSync(Buffer.concat(blocks));
}

/** A zip of stored (uncompressed) files, only as much of the format as the reader needs. */
function zipOf(files: Record<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const BINARY = Buffer.from("#!/bin/sh\necho osv\n");
const pinsFor = (host: string, bytes: Buffer, templates?: string): ScannerPins => ({
  "osv-scanner": { version: "9.9.9", sha256: { [host]: sha256Hex(bytes) } },
  trivy: { version: "9.9.9", sha256: {} },
  ...(templates
    ? { "nuclei-templates": { version: "1.2.3", sha256: { content: templates } } }
    : {}),
});

describe("isOfficialDownloadUrl", () => {
  it("accepts GitHub release and CDN hosts over https and nothing else", () => {
    expect(isOfficialDownloadUrl("https://github.com/o/r/releases/download/v1/x")).toBe(true);
    expect(isOfficialDownloadUrl("https://codeload.github.com/o/r/tar.gz/v1")).toBe(true);
    expect(
      isOfficialDownloadUrl("https://release-assets.githubusercontent.com/github-production/x"),
    ).toBe(true);
    for (const bad of [
      "http://github.com/x",
      "https://github.com.evil.com/x",
      "https://evil.com/github.com",
      "https://user@github.com/x",
      "https://githubusercontent.com.evil.org/x",
      "ftp://github.com/x",
      "not a url",
    ]) {
      expect(isOfficialDownloadUrl(bad), bad).toBe(false);
    }
  });

  it("refuses to follow a redirect to another host", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example.com/x" },
      })) as unknown as typeof fetch;
    try {
      await expect(
        downloadOfficial("https://github.com/o/r/releases/download/v1/x"),
      ).rejects.toThrow(/Refusing to download from evil\.example\.com/u);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("installTool", () => {
  it("downloads the pinned asset, keeps the executable, and reuses it", async () => {
    const dir = await cache();
    const urls: string[] = [];
    const download = async (url: string) => {
      urls.push(url);
      return BINARY;
    };
    const pins = pinsFor("linux-x64", BINARY);
    const first = await installTool("osv-scanner", {
      cacheDir: dir,
      host: "linux-x64",
      download,
      pins,
    });
    expect(first).toEqual({
      ok: true,
      path: path.join(installedToolDir(dir, "osv-scanner", pins), "osv-scanner"),
    });
    expect(urls).toEqual([
      "https://github.com/google/osv-scanner/releases/download/v9.9.9/osv-scanner_linux_amd64",
    ]);
    expect(await readFile((first as { path: string }).path)).toEqual(BINARY);
    if (process.platform !== "win32") {
      expect(((await stat((first as { path: string }).path)).mode & 0o111) !== 0).toBe(true);
    }
    await installTool("osv-scanner", { cacheDir: dir, host: "linux-x64", download, pins });
    expect(urls).toHaveLength(1);
    // Nothing is left half-written beside it.
    expect((await readdir(dir)).filter((entry) => entry.startsWith(".tmp-"))).toEqual([]);
  });

  it("uses the Windows asset and an .exe name on win32", async () => {
    const dir = await cache();
    const urls: string[] = [];
    const result = await installTool("osv-scanner", {
      cacheDir: dir,
      host: "win32-x64",
      download: async (url) => {
        urls.push(url);
        return BINARY;
      },
      pins: pinsFor("win32-x64", BINARY),
    });
    expect(urls[0]).toMatch(/osv-scanner_windows_amd64\.exe$/u);
    expect(result).toMatchObject({ ok: true, path: expect.stringMatching(/osv-scanner\.exe$/u) });
  });

  it("takes the executable out of a tar.gz on Linux and macOS and out of a zip on Windows", async () => {
    const tool = Buffer.from("tool binary");
    const tarball = tarGz({ LICENSE: "x", gitleaks: tool.toString() });
    const archive = zipOf({ LICENSE: Buffer.from("x"), "trivy.exe": tool });
    const pins: ScannerPins = {
      gitleaks: {
        version: "1.0.0",
        sha256: { "linux-x64": sha256Hex(tarball), "darwin-arm64": sha256Hex(tarball) },
      },
      trivy: { version: "1.0.0", sha256: { "win32-x64": sha256Hex(archive) } },
    };
    for (const host of ["linux-x64", "darwin-arm64"]) {
      const dir = await cache();
      const urls: string[] = [];
      const result = await installTool("gitleaks", {
        cacheDir: dir,
        host,
        pins,
        download: async (url) => {
          urls.push(url);
          return tarball;
        },
      });
      expect(urls[0]).toMatch(
        host === "linux-x64"
          ? /gitleaks_1\.0\.0_linux_x64\.tar\.gz$/u
          : /gitleaks_1\.0\.0_darwin_arm64\.tar\.gz$/u,
      );
      expect(result).toMatchObject({ ok: true, path: expect.stringMatching(/gitleaks$/u) });
      expect(await readFile((result as { path: string }).path)).toEqual(tool);
    }
    const dir = await cache();
    const urls: string[] = [];
    const win = await installTool("trivy", {
      cacheDir: dir,
      host: "win32-x64",
      pins,
      download: async (url) => {
        urls.push(url);
        return archive;
      },
    });
    expect(urls[0]).toMatch(/trivy_1\.0\.0_windows-64bit\.zip$/u);
    expect(win).toMatchObject({ ok: true, path: expect.stringMatching(/trivy\.exe$/u) });
    expect(await readFile((win as { path: string }).path)).toEqual(tool);
  });

  it("discards a download that does not match its pin", async () => {
    const dir = await cache();
    const result = await installTool("osv-scanner", {
      cacheDir: dir,
      host: "linux-x64",
      download: async () => Buffer.from("tampered"),
      pins: pinsFor("linux-x64", BINARY),
    });
    expect(result).toMatchObject({ ok: false, kind: "checksum" });
    expect(await readdir(dir)).toEqual([]);
  });

  it("reports a failed download and a host the project builds nothing for", async () => {
    const dir = await cache();
    const pins = pinsFor("linux-x64", BINARY);
    expect(
      await installTool("osv-scanner", {
        cacheDir: dir,
        host: "linux-x64",
        download: async () => {
          throw new Error("getaddrinfo ENOTFOUND github.com");
        },
        pins,
      }),
    ).toMatchObject({ ok: false, kind: "download", message: expect.stringContaining("ENOTFOUND") });
    expect(
      await installTool("trivy", {
        cacheDir: dir,
        host: "win32-arm64",
        pins,
        download: async () => BINARY,
      }),
    ).toMatchObject({ ok: false, kind: "unsupported" });
  });

  it("downloads once when two scans ask at the same time", async () => {
    const dir = await cache();
    let calls = 0;
    const download = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return BINARY;
    };
    const pins = pinsFor("linux-x64", BINARY);
    const both = await Promise.all([
      installTool("osv-scanner", { cacheDir: dir, host: "linux-x64", download, pins }),
      installTool("osv-scanner", { cacheDir: dir, host: "linux-x64", download, pins }),
    ]);
    expect(calls).toBe(1);
    expect(both.every((result) => result.ok)).toBe(true);
  });
});

describe("installNucleiTemplates", () => {
  const archive = tarGz({
    "nuclei-templates-1.2.3/http/misconfiguration/x.yaml": "id: x\n",
    "nuclei-templates-1.2.3/http/exposures/y.yaml": "id: y\n",
    "nuclei-templates-1.2.3/README.md": "docs",
  });
  const digest = templatesDigest(templatesFromArchive(archive));

  it("extracts the templates into the cache folder `nuclei -t` reads", async () => {
    const dir = await cache();
    const pins = pinsFor("linux-x64", BINARY, digest);
    const result = await installNucleiTemplates({
      cacheDir: dir,
      download: async () => archive,
      pins,
    });
    expect(result).toEqual({ ok: true, path: installedTemplatesDir(dir, pins) });
    const root = (result as { path: string }).path;
    expect(await readFile(path.join(root, "http/misconfiguration/x.yaml"), "utf8")).toBe("id: x\n");
    await expect(stat(path.join(root, "README.md"))).rejects.toThrow();
  });

  it("discards templates whose digest differs from the pin", async () => {
    const dir = await cache();
    const result = await installNucleiTemplates({
      cacheDir: dir,
      download: async () => archive,
      pins: pinsFor("linux-x64", BINARY, "0".repeat(64)),
    });
    expect(result).toMatchObject({ ok: false, kind: "checksum" });
    expect(await readdir(dir)).toEqual([]);
  });
});
