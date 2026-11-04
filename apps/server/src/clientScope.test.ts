import { describe, expect, it } from "vitest";

import { clientScopeFromUpgrade, isVisibleToClient } from "./clientScope.ts";

describe("clientScopeFromUpgrade", () => {
  it("ignores the client id on an unscoped server", () => {
    expect(clientScopeFromUpgrade(new URLSearchParams("client=me-0123abcd"), false)).toBeNull();
    expect(clientScopeFromUpgrade(new URLSearchParams(""), undefined)).toBeNull();
  });

  it("requires a valid client id on a scoped server", () => {
    expect(clientScopeFromUpgrade(new URLSearchParams("client=me-0123abcd"), true)).toBe(
      "me-0123abcd",
    );
    expect(clientScopeFromUpgrade(new URLSearchParams(""), true)).toBe("invalid");
    expect(clientScopeFromUpgrade(new URLSearchParams("client=../x"), true)).toBe("invalid");
  });
});

describe("isVisibleToClient", () => {
  it("shows everything unscoped and only owned data when scoped", () => {
    expect(isVisibleToClient(null, null)).toBe(true);
    expect(isVisibleToClient(null, "a-0123abcd")).toBe(true);
    expect(isVisibleToClient("a-0123abcd", "a-0123abcd")).toBe(true);
    expect(isVisibleToClient("a-0123abcd", "b-0123abcd")).toBe(false);
    expect(isVisibleToClient("a-0123abcd", null)).toBe(false);
  });
});
