import { describe, expect, it, vi } from "vitest";

import { createDeferredPersistStorage } from "./storage";

describe("createDeferredPersistStorage resilience", () => {
  it("returns null instead of throwing when persisted JSON is corrupt or getItem throws", () => {
    const map = new Map<string, string>([["bad-json", "{corrupt"]]);
    const storage = createDeferredPersistStorage<{ count: number }, { count: number }>({
      getStorage: () => ({
        getItem: (key) => {
          if (key === "throws") throw new Error("SecurityError");
          return map.get(key) ?? null;
        },
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
        removeItem: () => {
          throw new Error("SecurityError");
        },
      }),
      partialize: (state) => state,
      debounceMs: 10,
    });

    expect(storage.getItem("bad-json")).toBeNull();
    expect(storage.getItem("throws")).toBeNull();
    expect(() => {
      storage.setItem("k", { state: { count: 1 }, version: 0 });
      storage.flush();
    }).not.toThrow();
    expect(() => storage.removeItem("k")).not.toThrow();
  });

  it("persists and parses valid state across flush", () => {
    const setItem = vi.fn();
    const map = new Map<string, string>();
    const storage = createDeferredPersistStorage<{ count: number }, { count: number }>({
      getStorage: () => ({
        getItem: (key) => map.get(key) ?? null,
        setItem: (key, value) => {
          setItem(key, value);
          map.set(key, value);
        },
        removeItem: (key) => {
          map.delete(key);
        },
      }),
      partialize: (state) => state,
      debounceMs: 50,
    });

    storage.setItem("ok", { state: { count: 7 }, version: 2 });
    storage.flush();
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(storage.getItem("ok")).toEqual({ state: { count: 7 }, version: 2 });
  });
});
