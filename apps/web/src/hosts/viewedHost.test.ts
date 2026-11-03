import { LOCAL_HOST_ID, scopeThread, sshHostId } from "@saint/shared/hostId";
import { ThreadId } from "@saint/contracts";
import { describe, expect, it } from "vitest";

import { isHostUsageHidden } from "../lib/providerUsageSnapshot";
import { serverQueryKeys } from "../lib/serverReactQuery";
import { hostIdFromPathname, hostScopedQueryKey } from "./viewedHost";

const remote = sshHostId("a1b2c3d4");
const other = sshHostId("e5f6a7b8");
const snapshotFields = { provider: "codex", limits: [], usageLines: [] };
const okSnapshot = { ...snapshotFields, status: "ok" } as never;
const errorSnapshot = { ...snapshotFields, status: "error" } as never;

describe("hostIdFromPathname", () => {
  it("reads the host of a routed thread", () => {
    const scoped = scopeThread(remote, ThreadId.makeUnsafe("t1"));
    expect(hostIdFromPathname(`/${encodeURIComponent(scoped)}`)).toBe(remote);
  });

  it("is this computer for local threads, other routes and malformed paths", () => {
    expect(hostIdFromPathname("/thread-1")).toBe(LOCAL_HOST_ID);
    expect(hostIdFromPathname("/settings")).toBe(LOCAL_HOST_ID);
    expect(hostIdFromPathname("/")).toBe(LOCAL_HOST_ID);
    expect(hostIdFromPathname("/%E0%A4%A")).toBe(LOCAL_HOST_ID);
  });
});

describe("host-scoped usage query keys", () => {
  it("keeps this computer's keys unchanged", () => {
    expect(serverQueryKeys.allProviderUsage()).toEqual(["server", "allProviderUsage"]);
    expect(serverQueryKeys.allProviderUsage(LOCAL_HOST_ID)).toEqual(["server", "allProviderUsage"]);
    expect(serverQueryKeys.providerUsage("codex", null)).toEqual([
      "server",
      "providerUsage",
      "codex",
      null,
    ]);
    expect(hostScopedQueryKey(["hyperagent", "economy"] as const, LOCAL_HOST_ID)).toEqual([
      "hyperagent",
      "economy",
    ]);
  });

  it("gives every host its own entry, under the shared invalidation prefix", () => {
    expect(serverQueryKeys.allProviderUsage(remote)).toEqual([
      "server",
      "allProviderUsage",
      remote,
    ]);
    expect(serverQueryKeys.allProviderUsage(remote)).not.toEqual(
      serverQueryKeys.allProviderUsage(other),
    );
    expect(serverQueryKeys.providerUsage("codex", null, remote)).toEqual([
      "server",
      "providerUsage",
      "codex",
      null,
      remote,
    ]);
    expect(hostScopedQueryKey(["hyperagent", "economy"] as const, remote)).toEqual([
      "hyperagent",
      "economy",
      remote,
    ]);
  });
});

describe("isHostUsageHidden", () => {
  it("never hides this computer's usage", () => {
    expect(isHostUsageHidden({ hostId: LOCAL_HOST_ID, isError: true, snapshot: undefined })).toBe(
      false,
    );
  });

  it("hides another host's usage unless it was read successfully", () => {
    expect(isHostUsageHidden({ hostId: remote, isError: false, snapshot: okSnapshot })).toBe(false);
    expect(isHostUsageHidden({ hostId: remote, isError: true, snapshot: okSnapshot })).toBe(true);
    expect(isHostUsageHidden({ hostId: remote, isError: false, snapshot: undefined })).toBe(true);
    expect(
      isHostUsageHidden({
        hostId: remote,
        isError: false,
        snapshot: errorSnapshot,
      }),
    ).toBe(true);
  });
});
