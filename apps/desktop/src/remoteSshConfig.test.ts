import { describe, expect, it } from "vitest";

import {
  clientRemoteRoot,
  createRemoteClientId,
  defaultRemoteRoot,
  isValidSshTarget,
  normalizeRemoteRoot,
  parseRemoteClientId,
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
    [".saint-remote", ".saint-remote"],
    ["~/team/saint-remote/", "team/saint-remote"],
    ["  squad/saint  ", "squad/saint"],
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
    expect(defaultRemoteRoot(".saint")).toBe(".saint-remote");
    expect(defaultRemoteRoot(".saint-beta")).toBe(".saint-beta-remote");
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
          { host: "k6", remoteRoot: "squad/saint" },
          { host: "devbox", remoteRoot: "dupe" },
          { host: "web", remoteRoot: "/abs" },
        ],
      }),
    );
    expect(saved).toEqual([
      { host: "devbox", remoteRoot: null },
      { host: "k6", remoteRoot: "squad/saint" },
      { host: "web", remoteRoot: null },
    ]);
    const updated = rememberRemoteSshHost(saved, { host: "k6", remoteRoot: null });
    expect(updated.map((entry) => entry.host)).toEqual(["k6", "devbox", "web"]);
    expect(parseSavedRemoteSshHosts(serializeSavedRemoteSshHosts(updated))).toEqual(updated);
  });

  it("keeps a valid host key across reads and re-remembering, and ignores a bad one", () => {
    const saved = parseSavedRemoteSshHosts(
      JSON.stringify({
        version: 1,
        hosts: [
          { host: "devbox", remoteRoot: null, hostKey: "a1b2c3d4" },
          { host: "k6", remoteRoot: null, hostKey: "not-a-key" },
        ],
      }),
    );
    expect(saved).toEqual([
      { host: "devbox", remoteRoot: null, hostKey: "a1b2c3d4" },
      { host: "k6", remoteRoot: null },
    ]);
    const updated = rememberRemoteSshHost(saved, { host: "devbox", remoteRoot: "squad/saint" });
    expect(updated[0]).toEqual({ host: "devbox", remoteRoot: "squad/saint", hostKey: "a1b2c3d4" });
  });

  it("treats unreadable files as empty", () => {
    expect(parseSavedRemoteSshHosts("not json")).toEqual([]);
    expect(parseSavedRemoteSshHosts("null")).toEqual([]);
  });
});

describe("remote client ids", () => {
  it("names the client after the local user plus random hex", () => {
    expect(createRemoteClientId("Anh.Nguyen", "0A1B2C3D4E")).toBe("anh-nguyen-0a1b2c3d");
    expect(createRemoteClientId("Ngô Văn", "deadbeef")).toBe("ng-v-n-deadbeef");
    expect(createRemoteClientId("", "deadbeef")).toBe("user-deadbeef");
  });

  it("produces ids that parse back and form a valid remote folder", () => {
    const id = createRemoteClientId("ac-claude-4", "0a1b2c3d");
    expect(parseRemoteClientId(`${id}\n`)).toBe(id);
    expect(normalizeRemoteRoot(clientRemoteRoot(".saint-remote", id))).toBe(
      ".saint-remote/clients/ac-claude-4-0a1b2c3d",
    );
  });

  it("rejects stored ids that are not ours", () => {
    expect(parseRemoteClientId("")).toBeNull();
    expect(parseRemoteClientId("../x-0a1b2c3d")).toBeNull();
    expect(parseRemoteClientId("anh")).toBeNull();
  });
});
