import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  getLocalStorageItem,
  getLocalStorageItemOrNull,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "./useLocalStorage";

describe("localStorage helpers resilience", () => {
  it("returns null from getLocalStorageItemOrNull on corrupt or schema-mismatched stored values while getLocalStorageItem still throws", () => {
    const key = "saint:test:useLocalStorage:corrupt";
    setLocalStorageItem(key, "not-a-number", Schema.String);
    expect(() => getLocalStorageItem(key, Schema.Finite)).toThrow();
    expect(getLocalStorageItemOrNull(key, Schema.Finite)).toBeNull();
    removeLocalStorageItem(key);
  });

  it("round-trips valid finite values and safely ignores invalid encodes", () => {
    const key = "saint:test:useLocalStorage:valid";
    setLocalStorageItem(key, 420, Schema.Finite);
    expect(getLocalStorageItemOrNull(key, Schema.Finite)).toBe(420);
    expect(() => setLocalStorageItem(key, Number.NaN, Schema.Finite)).not.toThrow();
    expect(getLocalStorageItemOrNull(key, Schema.Finite)).toBe(420);
    removeLocalStorageItem(key);
    expect(getLocalStorageItemOrNull(key, Schema.Finite)).toBeNull();
  });
});
