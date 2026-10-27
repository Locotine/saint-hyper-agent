import { describe, expect, it } from "vitest";

import { explorerDropDirectoryFor } from "./explorerFileDrop";

describe("explorerDropDirectoryFor", () => {
  it("drops onto a folder row into that folder", () => {
    expect(explorerDropDirectoryFor({ path: "docs/specs", kind: "directory" })).toBe("docs/specs");
  });

  it("drops onto a file row into its parent folder", () => {
    expect(explorerDropDirectoryFor({ path: "docs/specs/a.md", kind: "file" })).toBe("docs/specs");
    expect(explorerDropDirectoryFor({ path: "README.md", kind: "file" })).toBe("");
  });
});
