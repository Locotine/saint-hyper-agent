import { describe, expect, it } from "vitest";

import { REMOTE_SSH_EDITOR_IDS, buildRemoteSshEditorUrl } from "./remoteSshEditors";

describe("buildRemoteSshEditorUrl", () => {
  it("opens a remote folder in the local editor's Remote-SSH mode", () => {
    expect(
      buildRemoteSshEditorUrl({ host: "devbox", editor: "vscode", target: "/home/pt/app" }),
    ).toBe("vscode://vscode-remote/ssh-remote+devbox/home/pt/app");
    expect(
      buildRemoteSshEditorUrl({ host: "pt@10.0.0.2", editor: "cursor", target: "/srv/app" }),
    ).toBe("cursor://vscode-remote/ssh-remote+pt%4010.0.0.2/srv/app");
  });

  it("keeps a goto position and encodes path segments", () => {
    expect(
      buildRemoteSshEditorUrl({
        host: "k6",
        editor: "windsurf",
        target: "/home/pt/my app/src/main.ts:12:4",
      }),
    ).toBe("windsurf://vscode-remote/ssh-remote+k6/home/pt/my%20app/src/main.ts:12:4");
  });

  it("refuses editors without Remote-SSH and non-absolute targets", () => {
    expect(buildRemoteSshEditorUrl({ host: "k6", editor: "zed", target: "/a" })).toBeNull();
    expect(buildRemoteSshEditorUrl({ host: "k6", editor: "toString", target: "/a" })).toBeNull();
    expect(buildRemoteSshEditorUrl({ host: "k6", editor: "vscode", target: "a/b" })).toBeNull();
    expect(buildRemoteSshEditorUrl({ host: "k6", editor: "vscode", target: "C:\\a" })).toBeNull();
  });

  it("lists the VS Code family", () => {
    expect(REMOTE_SSH_EDITOR_IDS).toEqual([
      "vscode",
      "vscode-insiders",
      "cursor",
      "windsurf",
      "vscodium",
    ]);
  });
});
