import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as Zlib from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildScannerPack,
  checkScannerPack,
  createScannerTarGz,
  currentScannerHost,
  extractExecutable,
  parseChecksum,
  readScannerPackFiles,
  templatesDigest,
  templatesFromArchive,
  SCANNER_HOSTS,
  SCANNER_NAMES,
  SCANNER_PINS_PATH,
  SCANNERS,
  SCANNER_REMOTE_HOSTS,
  scannerDownloadUrls,
  scannerFileName,
  scannerHostsForBuild,
  scannerPackFileName,
  scannersForHost,
  updateScannerPins,
  type ScannerFetch,
} from "./lib/scanner-pack.ts";

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

const temporaryDirs: string[] = [];
afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "saint-scanner-pack-test-"));
  temporaryDirs.push(dir);
  return dir;
}

/** A one-file zip with the file stored uncompressed or deflated. */
function zipOf(name: string, contents: Buffer, deflate: boolean): Buffer {
  const data = deflate ? Zlib.deflateRawSync(contents) : contents;
  const method = deflate ? 8 : 0;
  const crc = Zlib.crc32(contents);
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const localPart = Buffer.concat([local, nameBytes, data]);
  const centralPart = Buffer.concat([central, nameBytes]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, end]);
}

const nucleiTemplatesArchiveUrl =
  "https://github.com/projectdiscovery/nuclei-templates/archive/refs/tags/v10.2.9.tar.gz";

const urlOf = (repo: string, version: string, file: string) =>
  `https://github.com/${repo}/releases/download/v${version}/${file}`;

/** Release assets and checksum files for every scanner and host, served from memory. */
function makeRelease(versions: Record<string, string>) {
  const files = new Map<string, Buffer>();
  const pins: Record<string, { version: string; sha256: Record<string, string> }> = {};
  for (const spec of SCANNERS) {
    const version = versions[spec.name] ?? "1.0.0";
    pins[spec.name] = { version, sha256: {} };
    for (const host of SCANNER_HOSTS) {
      const [os, arch] = host.split("-") as [string, string];
      const asset = spec.asset(version, os, arch);
      // A project with no build for this host (Windows arm64) publishes nothing to serve.
      if (!asset) continue;
      const binary = Buffer.from(`${spec.name} ${version} ${host}`);
      const file = scannerFileName(spec.name, host);
      const kind = spec.kind(os);
      const bytes =
        kind === "raw"
          ? binary
          : kind === "zip"
            ? zipOf(file, binary, true)
            : createScannerTarGz({ LICENSE: Buffer.from("MIT"), [file]: binary });
      files.set(urlOf(spec.repo, version, asset), bytes);
      // GitHub records each asset's sha256 too; update-pins cross-checks it.
      const api = `https://api.github.com/repos/${spec.repo}/releases/tags/v${version}`;
      const listing = JSON.parse(files.get(api)?.toString() ?? '{"assets":[]}');
      listing.assets.push({ name: asset, digest: `sha256:${sha(bytes)}` });
      files.set(api, Buffer.from(JSON.stringify(listing)));
      const checksums = urlOf(spec.repo, version, spec.checksums(version, asset));
      const line = `${sha(bytes)}  ${asset}\n`;
      files.set(checksums, Buffer.from((files.get(checksums)?.toString() ?? "") + line));
    }
  }
  const root = "nuclei-templates-10.2.9";
  const archive = createScannerTarGz({
    [`${root}/http/cves/CVE-2024-0001.yaml`]: Buffer.from("id: cve"),
    [`${root}/http/${"d".repeat(70)}/${"e".repeat(60)}.yaml`]: Buffer.from("id: long"),
    [`${root}/.github/workflows/ci.yaml`]: Buffer.from("hidden"),
    [`${root}/http/README.md`]: Buffer.from("docs"),
    [`${root}/README.md`]: Buffer.from("docs"),
  });
  files.set(nucleiTemplatesArchiveUrl, archive);
  files.set(
    "https://github.com/projectdiscovery/nuclei-templates/releases/download/v10.2.9/nuclei-templates-10.2.9_checksums.txt",
    Buffer.from(`${sha(archive)}  nuclei-templates-10.2.9.tar.gz\n`),
  );
  pins["nuclei-templates"] = { version: "10.2.9", sha256: {} };
  const fetchBytes: ScannerFetch = async (url) => {
    const found = files.get(url);
    if (!found) throw new Error(`unexpected fetch ${url}`);
    return found;
  };
  return { files, pins, fetchBytes };
}

function makeRepo(pins: unknown): string {
  const root = temp();
  mkdirSync(dirname(join(root, SCANNER_PINS_PATH)), { recursive: true });
  writeFileSync(join(root, SCANNER_PINS_PATH), JSON.stringify(pins));
  return root;
}

describe("release asset names", () => {
  // Names and checksum files seen in the GitHub release listings of the pinned versions.
  // `null`: the project publishes no build for that host.
  const expected: Record<string, Record<string, [string, string] | null>> = {
    gitleaks: {
      "darwin-arm64": ["gitleaks_9.9.9_darwin_arm64.tar.gz", "gitleaks_9.9.9_checksums.txt"],
      "darwin-x64": ["gitleaks_9.9.9_darwin_x64.tar.gz", "gitleaks_9.9.9_checksums.txt"],
      "linux-arm64": ["gitleaks_9.9.9_linux_arm64.tar.gz", "gitleaks_9.9.9_checksums.txt"],
      "linux-x64": ["gitleaks_9.9.9_linux_x64.tar.gz", "gitleaks_9.9.9_checksums.txt"],
      "win32-arm64": ["gitleaks_9.9.9_windows_arm64.zip", "gitleaks_9.9.9_checksums.txt"],
      "win32-x64": ["gitleaks_9.9.9_windows_x64.zip", "gitleaks_9.9.9_checksums.txt"],
    },
    "osv-scanner": {
      "darwin-arm64": ["osv-scanner_darwin_arm64", "osv-scanner_SHA256SUMS"],
      "darwin-x64": ["osv-scanner_darwin_amd64", "osv-scanner_SHA256SUMS"],
      "linux-arm64": ["osv-scanner_linux_arm64", "osv-scanner_SHA256SUMS"],
      "linux-x64": ["osv-scanner_linux_amd64", "osv-scanner_SHA256SUMS"],
      "win32-arm64": ["osv-scanner_windows_arm64.exe", "osv-scanner_SHA256SUMS"],
      "win32-x64": ["osv-scanner_windows_amd64.exe", "osv-scanner_SHA256SUMS"],
    },
    trivy: {
      "darwin-arm64": ["trivy_9.9.9_macOS-ARM64.tar.gz", "trivy_9.9.9_checksums.txt"],
      "darwin-x64": ["trivy_9.9.9_macOS-64bit.tar.gz", "trivy_9.9.9_checksums.txt"],
      "linux-arm64": ["trivy_9.9.9_Linux-ARM64.tar.gz", "trivy_9.9.9_checksums.txt"],
      "linux-x64": ["trivy_9.9.9_Linux-64bit.tar.gz", "trivy_9.9.9_checksums.txt"],
      "win32-arm64": null,
      "win32-x64": ["trivy_9.9.9_windows-64bit.zip", "trivy_9.9.9_checksums.txt"],
    },
    hadolint: {
      "darwin-arm64": ["hadolint-macos-arm64", "checksums.sha256"],
      "darwin-x64": ["hadolint-macos-x86_64", "checksums.sha256"],
      "linux-arm64": ["hadolint-linux-arm64", "checksums.sha256"],
      "linux-x64": ["hadolint-linux-x86_64", "checksums.sha256"],
      "win32-arm64": null,
      "win32-x64": ["hadolint-windows-x86_64.exe", "checksums.sha256"],
    },
    nuclei: {
      "darwin-arm64": ["nuclei_9.9.9_macOS_arm64.zip", "nuclei_9.9.9_checksums.txt"],
      "darwin-x64": ["nuclei_9.9.9_macOS_amd64.zip", "nuclei_9.9.9_checksums.txt"],
      "linux-arm64": ["nuclei_9.9.9_linux_arm64.zip", "nuclei_9.9.9_checksums.txt"],
      "linux-x64": ["nuclei_9.9.9_linux_amd64.zip", "nuclei_9.9.9_checksums.txt"],
      "win32-arm64": null,
      "win32-x64": ["nuclei_9.9.9_windows_amd64.zip", "nuclei_9.9.9_checksums.txt"],
    },
  };
  const repos: Record<string, string> = {
    gitleaks: "gitleaks/gitleaks",
    "osv-scanner": "google/osv-scanner",
    trivy: "aquasecurity/trivy",
    hadolint: "hadolint/hadolint",
    nuclei: "projectdiscovery/nuclei",
  };

  it.each(SCANNER_NAMES)("builds the real %s asset and checksum URLs on every host", (name) => {
    for (const host of SCANNER_HOSTS) {
      const names = expected[name]![host];
      if (!names) {
        expect(() => scannerDownloadUrls(name, "9.9.9", host)).toThrow(/publishes no build/u);
        continue;
      }
      expect(scannerDownloadUrls(name, "9.9.9", host)).toEqual({
        asset: urlOf(repos[name]!, "9.9.9", names[0]),
        checksums: urlOf(repos[name]!, "9.9.9", names[1]),
      });
    }
  });

  it("covers every host, with Windows named by Node's platform", () => {
    expect([...SCANNER_HOSTS]).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-arm64",
      "win32-x64",
    ]);
    expect(scannerFileName("trivy", "win32-x64")).toBe("trivy.exe");
    expect(scannerFileName("trivy", "linux-x64")).toBe("trivy");
  });

  it("holds every scanner on Windows x64 and only the ones with an arm64 build on Windows arm64", () => {
    const names = (host: string) => scannersForHost(host).map((spec) => spec.name);
    expect(names("win32-x64")).toEqual(SCANNER_NAMES);
    expect(names("win32-arm64")).toEqual(["gitleaks", "osv-scanner"]);
    expect(names("darwin-arm64")).toEqual(SCANNER_NAMES);
    expect(names("linux-arm64")).toEqual(SCANNER_NAMES);
  });

  it("sends no Windows tarball to remote SSH hosts, whose install scripts are POSIX shell", () => {
    expect(SCANNER_REMOTE_HOSTS).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
    ]);
  });

  it("stages the executables of the host a desktop build runs on", () => {
    expect(scannerHostsForBuild("win", "x64")).toEqual(["win32-x64"]);
    expect(scannerHostsForBuild("win", "arm64")).toEqual(["win32-arm64"]);
    expect(scannerHostsForBuild("mac", "universal")).toEqual(["darwin-arm64", "darwin-x64"]);
    expect(scannerHostsForBuild("linux", "x64")).toEqual(["linux-x64"]);
  });
});

describe("parseChecksum", () => {
  it("reads sha256sum lines, binary-mode markers and bare hashes", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    expect(parseChecksum(`${a}  one.tar.gz\n${b} *two.zip\n`, "two.zip")).toBe(b);
    expect(parseChecksum(`${a}\n`, "anything")).toBe(a);
  });

  it("fails when the asset is not listed", () => {
    expect(() =>
      parseChecksum(`${"a".repeat(64)}  one\n${"b".repeat(64)}  two\n`, "three"),
    ).toThrow(/No sha256 for three/u);
  });
});

describe("currentScannerHost", () => {
  it("names the machine's platform and arch, and rejects ones without a pack", () => {
    expect(currentScannerHost("linux", "x64")).toBe("linux-x64");
    expect(currentScannerHost("darwin", "arm64")).toBe("darwin-arm64");
    expect(currentScannerHost("win32", "x64")).toBe("win32-x64");
    expect(() => currentScannerHost("linux", "ia32")).toThrow(/No scanner pack for linux-ia32/u);
    expect(() => currentScannerHost("freebsd", "x64")).toThrow(/Supported hosts/u);
  });
});

describe("extractExecutable", () => {
  it("takes the named file out of tar.gz, stored zip and deflated zip, ignoring the rest", () => {
    const binary = Buffer.from("binary");
    expect(
      extractExecutable(
        "tar.gz",
        createScannerTarGz({ README: Buffer.from("x"), tool: binary }),
        "tool",
      ),
    ).toEqual(binary);
    expect(extractExecutable("zip", zipOf("tool", binary, false), "tool")).toEqual(binary);
    expect(extractExecutable("zip", zipOf("tool", binary, true), "tool")).toEqual(binary);
  });

  it("fails when the executable is not in the archive", () => {
    expect(() =>
      extractExecutable("tar.gz", createScannerTarGz({ other: Buffer.from("x") }), "tool"),
    ).toThrow(/tool is not in/u);
  });
});

describe("buildScannerPack and checkScannerPack", () => {
  it("writes one pack per host with only the executables, and checks as current", async () => {
    const release = makeRelease({});
    const repo = makeRepo(release.pins);
    // The pins are filled from the projects' checksum files, then the build verifies them.
    await updateScannerPins(repo, release.fetchBytes);
    const out = join(repo, "pack");
    const lock = await buildScannerPack(repo, out, { fetch: release.fetchBytes });

    expect(lock.version).toMatch(/^[0-9a-f]{12}$/u);
    expect(Object.keys(lock.hosts).toSorted()).toEqual([...SCANNER_HOSTS]);
    for (const host of SCANNER_HOSTS) {
      const files = readScannerPackFiles(out, host);
      const held = scannersForHost(host);
      // Executables at the root (`.exe` on Windows), the filtered templates under
      // nuclei-templates/, and the templates only where nuclei is.
      expect(
        Object.keys(files)
          .filter((path) => !path.includes("/"))
          .toSorted(),
      ).toEqual(held.map((spec) => scannerFileName(spec.name, host)).toSorted());
      expect(
        Object.keys(files)
          .filter((path) => path.includes("/"))
          .toSorted(),
      ).toEqual(
        held.some((spec) => spec.name === "nuclei")
          ? [
              "nuclei-templates/http/cves/CVE-2024-0001.yaml",
              `nuclei-templates/http/${"d".repeat(70)}/${"e".repeat(60)}.yaml`,
            ]
          : [],
      );
      if (held.some((spec) => spec.name === "trivy")) {
        expect(files[scannerFileName("trivy", host)]?.toString()).toBe(`trivy 1.0.0 ${host}`);
      }
      expect(lock.hosts[host]?.sha256).toBe(
        sha(readFileSync(join(out, scannerPackFileName(host)))),
      );
    }
    expect(lock.templates).toMatchObject({ version: "10.2.9", files: 2 });
    expect(JSON.parse(readFileSync(join(out, "scanners.json"), "utf8"))).toEqual(lock);
    expect(checkScannerPack(repo, out)).toEqual([]);
  });

  it("fetches binaries only for the hosts it is asked to build", async () => {
    const release = makeRelease({});
    const repo = makeRepo(release.pins);
    await updateScannerPins(repo, release.fetchBytes);
    const urls: string[] = [];
    const recording: ScannerFetch = (url) => {
      urls.push(url);
      return release.fetchBytes(url);
    };
    const out = join(repo, "one");
    const lock = await buildScannerPack(repo, out, { fetch: recording, hosts: ["linux-x64"] });

    expect(Object.keys(lock.hosts)).toEqual(["linux-x64"]);
    const assets = urls.filter((url) => url.includes("/releases/download/"));
    expect(assets.length).toBeGreaterThan(0);
    // Every other host's asset name is absent from what was requested.
    for (const host of SCANNER_HOSTS.filter((candidate) => candidate !== "linux-x64")) {
      for (const spec of scannersForHost(host)) {
        const other = scannerDownloadUrls(spec.name, release.pins[spec.name]!.version, host).asset;
        const same = scannerDownloadUrls(
          spec.name,
          release.pins[spec.name]!.version,
          "linux-x64",
        ).asset;
        if (other !== same) expect(urls).not.toContain(other);
      }
    }
    expect(checkScannerPack(repo, out, ["linux-x64"])).toEqual([]);
    expect(checkScannerPack(repo, out)).not.toEqual([]);
  });

  it("builds the same bytes twice", async () => {
    const release = makeRelease({});
    const repo = makeRepo(release.pins);
    await updateScannerPins(repo, release.fetchBytes);
    const first = await buildScannerPack(repo, join(repo, "a"), { fetch: release.fetchBytes });
    const second = await buildScannerPack(repo, join(repo, "b"), { fetch: release.fetchBytes });
    expect(second).toEqual(first);
  });

  it("update-pins refuses a checksum file that disagrees with the digest GitHub records", async () => {
    const release = makeRelease({});
    const repo = makeRepo(release.pins);
    const api = "https://api.github.com/repos/hadolint/hadolint/releases/tags/v1.0.0";
    const listing = JSON.parse(release.files.get(api)!.toString());
    listing.assets[0].digest = `sha256:${"0".repeat(64)}`;
    release.files.set(api, Buffer.from(JSON.stringify(listing)));
    await expect(updateScannerPins(repo, release.fetchBytes)).rejects.toThrow(/GitHub records/u);
  });

  it("update-pins refuses a templates archive its project's checksum file does not list", async () => {
    const release = makeRelease({});
    const repo = makeRepo(release.pins);
    release.files.set(
      "https://github.com/projectdiscovery/nuclei-templates/releases/download/v10.2.9/nuclei-templates-10.2.9_checksums.txt",
      Buffer.from(`${"0".repeat(64)}  nuclei-templates-10.2.9.tar.gz\n`),
    );
    await expect(updateScannerPins(repo, release.fetchBytes)).rejects.toThrow(
      /checksum file lists/u,
    );
  });

  it("refuses a download that differs from its pinned sha256 and writes nothing", async () => {
    const release = makeRelease({});
    const repo = makeRepo(release.pins);
    await updateScannerPins(repo, release.fetchBytes);
    const tampered: ScannerFetch = async (url) =>
      url.includes("hadolint-linux-x86_64") && !url.endsWith(".sha256")
        ? Buffer.from("tampered")
        : release.fetchBytes(url);
    const out = join(repo, "pack");
    await expect(buildScannerPack(repo, out, { fetch: tampered })).rejects.toThrow(/pinned/u);
    expect(() => readFileSync(join(out, "scanners.json"))).toThrow();
  });

  it("refuses templates that differ from their pinned content digest and writes nothing", async () => {
    const release = makeRelease({});
    const repo = makeRepo(release.pins);
    await updateScannerPins(repo, release.fetchBytes);
    const changed: ScannerFetch = async (url) =>
      url === nucleiTemplatesArchiveUrl
        ? createScannerTarGz({ "nuclei-templates-10.2.9/http/x.yaml": Buffer.from("id: evil") })
        : release.fetchBytes(url);
    const out = join(repo, "pack");
    await expect(buildScannerPack(repo, out, { fetch: changed })).rejects.toThrow(
      /nuclei-templates digest/u,
    );
    expect(() => readFileSync(join(out, "scanners.json"))).toThrow();
  });

  it("pins templates by file content, not by how the archive is packed", () => {
    const a = templatesFromArchive(
      createScannerTarGz({
        "r-1/http/a.yaml": Buffer.from("a"),
        "r-1/http/b.json": Buffer.from("b"),
      }),
    );
    const b = templatesFromArchive(
      createScannerTarGz({
        "other-root/http/b.json": Buffer.from("b"),
        "other-root/http/a.yaml": Buffer.from("a"),
      }),
    );
    expect(templatesDigest(a)).toBe(templatesDigest(b));
    expect(() =>
      templatesFromArchive(createScannerTarGz({ "r/README.md": Buffer.from("x") })),
    ).toThrow(/empty/u);
  });

  it("refuses to build while a pin is empty", async () => {
    const release = makeRelease({});
    const repo = makeRepo(release.pins);
    await expect(
      buildScannerPack(repo, join(repo, "pack"), { fetch: release.fetchBytes }),
    ).rejects.toThrow(/has no (sha256|content digest)/u);
  });

  it("reports a missing pack, a bumped version, and a modified tarball", async () => {
    const release = makeRelease({});
    const repo = makeRepo(release.pins);
    await updateScannerPins(repo, release.fetchBytes);
    const out = join(repo, "pack");
    expect(checkScannerPack(repo, out)).toEqual([expect.stringContaining("is missing")]);

    await buildScannerPack(repo, out, { fetch: release.fetchBytes });
    writeFileSync(join(out, scannerPackFileName("linux-x64")), "changed");
    expect(checkScannerPack(repo, out)).toEqual([
      expect.stringContaining("scanner-linux-x64.tar.gz sha256 differs"),
    ]);

    const pins = JSON.parse(readFileSync(join(repo, SCANNER_PINS_PATH), "utf8"));
    pins["nuclei-templates"].version = "10.9.9";
    pins.gitleaks.version = "9.9.9";
    writeFileSync(join(repo, SCANNER_PINS_PATH), JSON.stringify(pins));
    const problems = checkScannerPack(repo, out).join("\n");
    expect(problems).toContain("gitleaks is 9.9.9");
    expect(problems).toContain("nuclei-templates differs from its pin");
  });
});
