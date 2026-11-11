import { afterEach, describe, expect, it } from "vitest";

import { externalMcpLauncher, externalMcpShellCommand } from "./launcher.ts";

const originalServerEntry = process.env.SAINT_SERVER_ENTRY;
const originalElectronNodeMode = process.env.ELECTRON_RUN_AS_NODE;
const originalArgv1 = process.argv[1];

afterEach(() => {
  if (originalServerEntry === undefined) delete process.env.SAINT_SERVER_ENTRY;
  else process.env.SAINT_SERVER_ENTRY = originalServerEntry;
  if (originalElectronNodeMode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
  else process.env.ELECTRON_RUN_AS_NODE = originalElectronNodeMode;
  if (originalArgv1 === undefined) process.argv.splice(1, 1);
  else process.argv[1] = originalArgv1;
});

describe("external MCP launcher", () => {
  it("uses the packaged backend entry instead of assuming a global saint command", () => {
    process.env.SAINT_SERVER_ENTRY = "/Applications/Saint.app/Contents/Resources/server/index.js";
    process.env.ELECTRON_RUN_AS_NODE = "1";
    const launcher = externalMcpLauncher(["mcp", "serve", "--integration", "integration-1"]);

    expect(launcher).toEqual({
      command: process.execPath,
      args: [
        "/Applications/Saint.app/Contents/Resources/server/index.js",
        "mcp",
        "serve",
        "--integration",
        "integration-1",
      ],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(externalMcpShellCommand(launcher)).toContain("ELECTRON_RUN_AS_NODE='1'");
    expect(externalMcpShellCommand(launcher)).not.toContain("saint mcp serve");
  });

  it("omits Bun standalone virtual filesystem entry paths when SAINT_SERVER_ENTRY is unset", () => {
    delete process.env.SAINT_SERVER_ENTRY;
    delete process.env.ELECTRON_RUN_AS_NODE;

    process.argv[1] = "/$bunfs/root/saint-server";
    expect(externalMcpLauncher(["mcp", "serve"])).toEqual({
      command: process.execPath,
      args: ["mcp", "serve"],
    });

    process.argv[1] = "B:\\~BUN\\root\\saint-server.exe";
    expect(externalMcpLauncher(["mcp", "serve"])).toEqual({
      command: process.execPath,
      args: ["mcp", "serve"],
    });
  });

  it("renders a valid PowerShell command on Windows", () => {
    expect(
      externalMcpShellCommand(
        {
          command: "C:\\Program Files\\Saint\\Saint.exe",
          args: ["mcp", "serve", "--home-dir", "C:\\Saint home"],
          env: { ELECTRON_RUN_AS_NODE: "1" },
        },
        "win32",
      ),
    ).toBe(
      "$env:ELECTRON_RUN_AS_NODE = '1'; & 'C:\\Program Files\\Saint\\Saint.exe' 'mcp' 'serve' '--home-dir' 'C:\\Saint home'",
    );
  });
});
