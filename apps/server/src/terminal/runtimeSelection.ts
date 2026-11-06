// FILE: runtimeSelection.ts
// Purpose: Selects the PTY implementation for the current JavaScript runtime and host platform.
// Layer: Terminal infrastructure

export type PtyAdapterRuntime = "bun" | "node" | "rust";

export function selectPtyAdapterRuntime(input: {
  readonly platform: NodeJS.Platform;
  readonly runtime: "bun" | "node";
  readonly env?: NodeJS.ProcessEnv | undefined;
}): PtyAdapterRuntime {
  const env = input.env;
  if (
    env?.SAINT_NATIVE_PTY_BACKEND?.trim() === "rust-portable-pty" &&
    (env.SAINT_RUST_PTY_PORT?.trim().length ?? 0) > 0 &&
    (env.SAINT_RUST_PTY_TOKEN?.trim().length ?? 0) > 0
  ) {
    return "rust";
  }
  // node-pty ships a Windows ConPTY binding and can be loaded from Bun, so use
  // the same stable implementation under either JavaScript runtime on Windows.
  return input.platform === "win32" ? "node" : input.runtime;
}
