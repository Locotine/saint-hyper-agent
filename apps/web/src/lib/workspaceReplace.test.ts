import { describe, expect, it } from "vitest";

import { replaceAllCaseInsensitive } from "./workspaceReplace";

describe("replaceAllCaseInsensitive", () => {
  it("replaces every occurrence regardless of case and counts them", () => {
    expect(replaceAllCaseInsensitive("Foo foo FOO", "foo", "bar")).toEqual({
      contents: "bar bar bar",
      count: 3,
    });
  });

  it("treats the query and replacement literally", () => {
    expect(replaceAllCaseInsensitive("a.b axb", "a.b", "$&-$1")).toEqual({
      contents: "$&-$1 axb",
      count: 1,
    });
  });

  it("reports zero when nothing matches", () => {
    expect(replaceAllCaseInsensitive("abc", "zz", "y")).toEqual({ contents: "abc", count: 0 });
  });
});
