import { describe, expect, it } from "vitest";

import { createMemoryStorage, withLegacyKeyFallback, type SyncStateStorage } from "./storage";

function memory(): SyncStateStorage {
  return createMemoryStorage() as SyncStateStorage;
}

describe("withLegacyKeyFallback", () => {
  it("reads the legacy key until the new key is written", () => {
    const base = memory();
    base.setItem("old", "legacy");
    const storage = withLegacyKeyFallback(base, "old");

    expect(storage.getItem("new")).toBe("legacy");
    storage.setItem("new", "fresh");
    expect(storage.getItem("new")).toBe("fresh");
  });

  it("never writes or removes the legacy key, so a rollback still finds it", () => {
    const base = memory();
    base.setItem("old", "legacy");
    const storage = withLegacyKeyFallback(base, "old");

    storage.setItem("new", "fresh");
    storage.removeItem("new");
    expect(base.getItem("old")).toBe("legacy");
  });

  it("returns null when neither key exists", () => {
    expect(withLegacyKeyFallback(memory(), "old").getItem("new")).toBeNull();
  });
});
