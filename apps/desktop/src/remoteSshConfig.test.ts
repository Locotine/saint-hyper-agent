import { describe, expect, it } from "vitest";

import {
  defaultRemoteRoot,
  isValidSshTarget,
  normalizeRemoteRoot,
  parseSavedRemoteSshHosts,
  parseSshConfigHosts,
  rememberRemoteSshHost,
  serializeSavedRemoteSshHosts,
} from "./remoteSshConfig";

describe("parseSshConfigHosts", () => {
  it("lists concrete aliases and skips patterns, negations and comments", () => {
    const config = [
      "Host *",
      "  ServerAliveInterval 30",
      "Host devbox k6 # build machines",
      "  HostName 10.0.0.2",
      "host=staging",
      "Host *.internal !bastion web?",
      "# Host commented",
      "Host devbox",
    ].join("\n");
    expect(parseSshConfigHosts(config)).toEqual(["devbox", "k6", "staging"]);
  });
});

describe("isValidSshTarget", () => {
  it.each(["devbox", "user@example.com", "pt@192.168.1.10", "[::1]", "host_1.local"])(
    "accepts %s",
    (value) => {
      expect(isValidSshTarget(value)).toBe(true);
    },
  );

  it.each(["", "-oProxyCommand=evil", "host name", "a;b", "$(id)", "host\nother"])(
    "rejects %j",
    (value) => {
      expect(isValidSshTarget(value)).toBe(false);
    },
  );
});

describe("normalizeRemoteRoot", () => {
  it.each([
    [".synara-remote", ".synara-remote"],
    ["~/team/synara-remote/", "team/synara-remote"],
    ["  squad/synara  ", "squad/synara"],
  ])("normalizes %j", (input, expected) => {
    expect(normalizeRemoteRoot(input)).toBe(expected);
  });

  it.each(["", "/etc", "../outside", "a/../b", "a//b", "with space", "$HOME/x", "a/./b"])(
    "rejects %j",
    (input) => {
      expect(normalizeRemoteRoot(input)).toBeNull();
    },
  );
});

describe("defaultRemoteRoot", () => {
  it("derives a per-flavor folder from the local home folder name", () => {
    expect(defaultRemoteRoot(".synara")).toBe(".synara-remote");
    expect(defaultRemoteRoot(".synara-beta")).toBe(".synara-beta-remote");
  });
});

describe("saved remote hosts", () => {
  it("round-trips, drops invalid entries, and keeps the newest first", () => {
    const saved = parseSavedRemoteSshHosts(
      JSON.stringify({
        version: 1,
        hosts: [
          { host: "devbox", remoteRoot: null },
          { host: "-bad" },
          { host: "k6", remoteRoot: "squad/synara" },
          { host: "devbox", remoteRoot: "dupe" },
          { host: "web", remoteRoot: "/abs" },
        ],
      }),
    );
    expect(saved).toEqual([
      { host: "devbox", remoteRoot: null },
      { host: "k6", remoteRoot: "squad/synara" },
      { host: "web", remoteRoot: null },
    ]);
    const updated = rememberRemoteSshHost(saved, { host: "k6", remoteRoot: null });
    expect(updated.map((entry) => entry.host)).toEqual(["k6", "devbox", "web"]);
    expect(parseSavedRemoteSshHosts(serializeSavedRemoteSshHosts(updated))).toEqual(updated);
  });

  it("treats unreadable files as empty", () => {
    expect(parseSavedRemoteSshHosts("not json")).toEqual([]);
    expect(parseSavedRemoteSshHosts("null")).toEqual([]);
  });
});
