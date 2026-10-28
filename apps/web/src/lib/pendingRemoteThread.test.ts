import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PENDING_REMOTE_THREAD_MAX_AGE_MS,
  rememberPendingRemoteThread,
  takePendingRemoteThread,
} from "./pendingRemoteThread";

function stubStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  });
  return data;
}

describe("pendingRemoteThread", () => {
  beforeEach(() => {
    stubStorage();
  });

  it("hands the thread to the host it was chosen on, once", () => {
    rememberPendingRemoteThread("devbox", "t1", 1000);
    expect(takePendingRemoteThread("devbox", 2000)).toBe("t1");
    expect(takePendingRemoteThread("devbox", 2000)).toBeNull();
  });

  it("drops the thread when this window is on another backend", () => {
    rememberPendingRemoteThread("devbox", "t1", 1000);
    expect(takePendingRemoteThread("k6", 2000)).toBeNull();
    expect(takePendingRemoteThread("devbox", 2000)).toBeNull();
  });

  it("ignores the local backend and stale requests", () => {
    rememberPendingRemoteThread("devbox", "t1", 1000);
    expect(takePendingRemoteThread(null, 2000)).toBeNull();
    rememberPendingRemoteThread("devbox", "t2", 1000);
    expect(
      takePendingRemoteThread("devbox", 1000 + PENDING_REMOTE_THREAD_MAX_AGE_MS + 1),
    ).toBeNull();
  });

  it("survives unreadable storage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => undefined,
    });
    expect(() => rememberPendingRemoteThread("devbox", "t1")).not.toThrow();
    expect(takePendingRemoteThread("devbox")).toBeNull();
  });
});
