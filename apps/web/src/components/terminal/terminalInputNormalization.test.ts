// FILE: terminalInputNormalization.test.ts
// Purpose: Covers non-breaking space normalization on terminal PTY input.
// Layer: Web terminal unit tests

import { describe, expect, it } from "vitest";

import { normalizeTerminalInputData } from "./terminalInputNormalization";

describe("normalizeTerminalInputData", () => {
  it("converts non-breaking spaces into ASCII spaces so POSIX shells split commands cleanly", () => {
    expect(normalizeTerminalInputData("git\u00a0pull\r")).toBe("git pull\r");
    expect(normalizeTerminalInputData("ls\u202f-la\u2007/tmp")).toBe("ls -la /tmp");
  });

  it("preserves ordinary ASCII, escape sequences, and Vietnamese UTF-8 text unchanged", () => {
    const sample = "\u001b[200~echo 'Xin chào thế giới'\u001b[201~\r";
    expect(normalizeTerminalInputData(sample)).toBe(sample);
  });
});
