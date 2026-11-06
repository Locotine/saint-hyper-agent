import { describe, expect, it } from "vitest";
import {
  resolveSidecarOutputPaths,
  resolveTauriTargetTriple,
} from "../../../scripts/build-server-sidecar";

describe("build-server-sidecar target resolution", () => {
  it("resolves canonical Tauri v2 target triples across Windows, macOS, and Linux", () => {
    expect(resolveTauriTargetTriple("win32", "x64")).toBe("x86_64-pc-windows-msvc");
    expect(resolveTauriTargetTriple("win32", "arm64")).toBe("aarch64-pc-windows-msvc");
    expect(resolveTauriTargetTriple("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(resolveTauriTargetTriple("darwin", "x64")).toBe("x86_64-apple-darwin");
    expect(resolveTauriTargetTriple("linux", "x64")).toBe("x86_64-unknown-linux-gnu");
    expect(resolveTauriTargetTriple("linux", "arm64")).toBe("aarch64-unknown-linux-gnu");
  });

  it("produces both triple-suffixed and plain sidecar paths", () => {
    const winPaths = resolveSidecarOutputPaths("/out", "win32", "x64");
    expect(winPaths.tripleBinaryPath).toMatch(/saint-server-x86_64-pc-windows-msvc\.exe$/);
    expect(winPaths.gnuBinaryPath).toMatch(/saint-server-x86_64-pc-windows-gnu\.exe$/);
    expect(winPaths.gnullvmBinaryPath).toMatch(/saint-server-x86_64-pc-windows-gnullvm\.exe$/);
    expect(winPaths.plainBinaryPath).toMatch(/saint-server\.exe$/);

    const macPaths = resolveSidecarOutputPaths("/out", "darwin", "arm64");
    expect(macPaths.tripleBinaryPath).toMatch(/saint-server-aarch64-apple-darwin$/);
    expect(macPaths.gnuBinaryPath).toBeNull();
    expect(macPaths.gnullvmBinaryPath).toBeNull();
    expect(macPaths.plainBinaryPath).toMatch(/saint-server$/);
  });
});
