import { sshHostId } from "@saint/shared/hostId";
import { describe, expect, it, vi } from "vitest";

import { createHostConnectionRegistry } from "./hostConnectionRegistry";

const hostA = sshHostId("a1b2c3d4");
const hostB = sshHostId("b2c3d4e5");

function makeRegistry() {
  const created: { url: string; dispose: ReturnType<typeof vi.fn> }[] = [];
  const registry = createHostConnectionRegistry((url) => {
    const transport = { url, dispose: vi.fn(async () => undefined) };
    created.push(transport);
    return transport;
  });
  return { registry, created };
}

describe("hostConnectionRegistry", () => {
  it("shares one transport per host and epoch and disposes it after the last release", () => {
    const { registry, created } = makeRegistry();
    const first = registry.acquire(hostA, 1, "ws://a");
    const second = registry.acquire(hostA, 1, "ws://a");
    expect(second.transport).toBe(first.transport);
    expect(created).toHaveLength(1);

    first.release();
    first.release();
    expect(created[0]?.dispose).not.toHaveBeenCalled();
    second.release();
    expect(created[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(registry.size()).toBe(0);
  });

  it("keeps hosts apart", () => {
    const { registry, created } = makeRegistry();
    const a = registry.acquire(hostA, 1, "ws://a");
    const b = registry.acquire(hostB, 1, "ws://b");
    expect(a.transport).not.toBe(b.transport);
    a.release();
    expect(created[0]?.dispose).toHaveBeenCalled();
    expect(created[1]?.dispose).not.toHaveBeenCalled();
  });

  it("builds a fresh transport for a new epoch and retires the old one on its last release", () => {
    const { registry, created } = makeRegistry();
    const old = registry.acquire(hostA, 1, "ws://a/?token=old");
    const next = registry.acquire(hostA, 2, "ws://a/?token=new");
    expect(next.transport).not.toBe(old.transport);
    expect(created.map((entry) => entry.url)).toEqual(["ws://a/?token=old", "ws://a/?token=new"]);
    expect(created[0]?.dispose).not.toHaveBeenCalled();

    old.release();
    expect(created[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(created[1]?.dispose).not.toHaveBeenCalled();
    expect(registry.size()).toBe(1);

    next.release();
    expect(created[1]?.dispose).toHaveBeenCalledTimes(1);
  });
});
