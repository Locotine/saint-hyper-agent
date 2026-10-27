import { describe, expect, it } from "vitest";

import { isPlainUploadFileName, uploadFileNameCandidates } from "./uploadFileName";

describe("isPlainUploadFileName", () => {
  it.each(["report.pdf", ".env", "a b (2).tar.gz", "ảnh.png"])("accepts %s", (name) => {
    expect(isPlainUploadFileName(name)).toBe(true);
  });

  it.each(["", ".", "..", "a/b", "a\\b", "a\0b", " lead", "x".repeat(256)])(
    "rejects %j",
    (name) => {
      expect(isPlainUploadFileName(name)).toBe(false);
    },
  );
});

describe("uploadFileNameCandidates", () => {
  it("numbers the stem and keeps the extension", () => {
    const candidates = [...uploadFileNameCandidates("report.tar.gz")];
    expect(candidates.slice(0, 3)).toEqual([
      "report.tar.gz",
      "report.tar (1).gz",
      "report.tar (2).gz",
    ]);
    expect(candidates).toHaveLength(1000);
  });

  it("treats a leading dot as part of the name", () => {
    expect([...uploadFileNameCandidates(".env")].slice(0, 2)).toEqual([".env", ".env (1)"]);
    expect([...uploadFileNameCandidates("Makefile")][1]).toBe("Makefile (1)");
  });
});
