import { describe, expect, it } from "vitest";

import { findDevServerListener } from "./dynamicRun.ts";
import { pickLocalTarget } from "./dynamicTarget.ts";
import { listenersOfTree, parseNetstatListeners } from "./windowsListeners.ts";

const V4 = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1180
  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       4321
  TCP    127.0.0.1:5173         127.0.0.1:50122        ESTABLISHED     4321
  TCP    192.168.1.20:3000      0.0.0.0:0              LISTENING       4400
  TCP    0.0.0.0:8080           0.0.0.0:0              ABHÖREN         4500
`;
const V6 = `
  Proto  Local Address          Foreign Address        State           PID
  TCP    [::]:3000              [::]:0                 LISTENING       4322
  TCP    [::1]:5174             [::]:0                 LISTENING       4323
  TCP    [fe80::1%12]:445       [::]:0                 LISTENING       4
`;

describe("parseNetstatListeners", () => {
  it("keeps listening sockets only, whatever language the state column is in", () => {
    expect(parseNetstatListeners(`${V4}\n${V6}`)).toEqual([
      { pid: 1180, host: "0.0.0.0", port: 135 },
      { pid: 4321, host: "127.0.0.1", port: 5173 },
      { pid: 4400, host: "192.168.1.20", port: 3000 },
      { pid: 4500, host: "0.0.0.0", port: 8080 },
      { pid: 4322, host: "[::]", port: 3000 },
      { pid: 4323, host: "[::1]", port: 5174 },
      { pid: 4, host: "[fe80::1%12]", port: 445 },
    ]);
  });

  it("ignores headers, blank lines and malformed rows", () => {
    expect(parseNetstatListeners("garbage\n\n  TCP  bad\r\n")).toEqual([]);
  });
});

describe("listenersOfTree", () => {
  const children = new Map([
    [100, [{ pid: 101, command: "node" }]],
    [101, [{ pid: 4321, command: "vite" }]],
  ]);
  const listeners = parseNetstatListeners(`${V4}\n${V6}`);

  it("returns only the sockets of the dev server and what it started", () => {
    expect(listenersOfTree(100, children, listeners)).toEqual([
      { host: "127.0.0.1", port: 5173, family: "tcp4", url: null },
    ]);
  });

  it("is empty when nothing in the tree listens, and the picker refuses a LAN-only address", () => {
    expect(listenersOfTree(999, children, listeners)).toEqual([]);
    const lan = listenersOfTree(4400, new Map(), listeners);
    expect(pickLocalTarget({ addresses: lan })).toMatchObject({ ok: false });
  });

  it("feeds the localhost-only target picker", () => {
    expect(pickLocalTarget({ addresses: listenersOfTree(100, children, listeners) })).toEqual({
      ok: true,
      target: { url: "http://127.0.0.1:5173", port: 5173, bridgeHost: "127.0.0.1" },
    });
  });
});

describe("findDevServerListener", () => {
  const devServer = {
    projectId: "p",
    command: "npm run dev",
    cwd: "C:\\proj",
    pid: 100,
    startedAt: "2026-01-01T00:00:00Z",
    status: "running",
  } as never;

  it("asks netstat on Windows and never the lsof-based monitor", async () => {
    const found = await findDevServerListener({
      devServer,
      tracked: [devServer],
      platform: "win32",
      readWindows: async (pid) => [{ host: "[::1]", port: 3000 + pid, family: "tcp6", url: null }],
      readLocalServers: async () => {
        throw new Error("must not be used on Windows");
      },
    });
    expect(found?.addresses).toEqual([{ host: "[::1]", port: 3100, family: "tcp6", url: null }]);
  });

  it("finds nothing yet on Windows when the dev server has no pid or no listener", async () => {
    expect(
      await findDevServerListener({
        devServer: { ...(devServer as object), pid: null } as never,
        tracked: [],
        platform: "win32",
      }),
    ).toBeNull();
    expect(
      await findDevServerListener({
        devServer,
        tracked: [devServer],
        platform: "win32",
        readWindows: async () => [],
      }),
    ).toBeNull();
  });

  it("uses the local server monitor on other platforms", async () => {
    const found = await findDevServerListener({
      devServer,
      tracked: [devServer],
      platform: "linux",
      readWindows: async () => {
        throw new Error("must not be used off Windows");
      },
      readLocalServers: async () => ({ servers: [] }),
    });
    expect(found).toBeNull();
  });
});
