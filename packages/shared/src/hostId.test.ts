import type { ProjectId, ThreadId } from "@saint/contracts";
import { describe, expect, it } from "vitest";

import {
  bareLocalThreadParam,
  generateHostKey,
  hostIdOf,
  isHostKey,
  LOCAL_HOST_ID,
  localThreadIdFromKey,
  parseHostId,
  parseScopedProjectId,
  parseScopedThreadId,
  scopeLocalThread,
  scopeProject,
  scopeThread,
  sshHostId,
  unscopeProject,
  unscopeThread,
} from "./hostId";

const thread = "11111111-2222-3333-4444-555555555555" as ThreadId;
const project = "proj-1" as ProjectId;
const remote = sshHostId("a1b2c3d4");

describe("hostId", () => {
  it("generates valid host keys", () => {
    for (let i = 0; i < 20; i++) expect(isHostKey(generateHostKey())).toBe(true);
  });

  it("parses host ids strictly", () => {
    expect(parseHostId("local")).toBe(LOCAL_HOST_ID);
    expect(parseHostId("ssh:a1b2c3d4")).toBe(remote);
    expect(parseHostId("ssh:")).toBeNull();
    expect(parseHostId("ssh:XYZ")).toBeNull();
    expect(parseHostId("remote")).toBeNull();
    expect(() => sshHostId("nope")).toThrow();
  });

  it("scopes a local thread to the local host", () => {
    expect(scopeLocalThread(thread)).toBe(scopeThread(LOCAL_HOST_ID, thread));
  });

  it("round-trips scoped thread and project ids", () => {
    const scoped = scopeThread(remote, thread);
    expect(scoped).toBe(`ssh:a1b2c3d4~${thread}`);
    expect(unscopeThread(scoped)).toEqual({ hostId: remote, threadId: thread });
    expect(unscopeProject(scopeProject(LOCAL_HOST_ID, project))).toEqual({
      hostId: LOCAL_HOST_ID,
      projectId: project,
    });
    expect(hostIdOf(scoped)).toBe(remote);
  });

  it("keeps the same raw id on two hosts distinct", () => {
    expect(scopeThread(LOCAL_HOST_ID, thread)).not.toBe(scopeThread(remote, thread));
  });

  it("keeps a raw id that contains the separator intact", () => {
    const odd = "a~b" as ThreadId;
    expect(unscopeThread(scopeThread(remote, odd)).threadId).toBe(odd);
  });

  it("treats an unprefixed value as a local raw id (legacy URLs and persisted state)", () => {
    expect(parseScopedThreadId(thread)).toBe(scopeThread(LOCAL_HOST_ID, thread));
    expect(parseScopedProjectId(project)).toBe(scopeProject(LOCAL_HOST_ID, project));
    const scoped = scopeThread(remote, thread);
    expect(parseScopedThreadId(scoped)).toBe(scoped);
    expect(parseScopedThreadId("")).toBeNull();
  });

  it("rejects malformed scoped ids", () => {
    expect(() => scopeThread(remote, "" as ThreadId)).toThrow();
    expect(() => unscopeThread(thread as never)).toThrow();
    expect(() => unscopeThread("bogus~x" as never)).toThrow();
  });
});

describe("bareLocalThreadParam", () => {
  it("shortens this computer's scoped ids and leaves everything else alone", () => {
    expect(bareLocalThreadParam(scopeLocalThread(thread))).toBe(thread);
    expect(bareLocalThreadParam(thread)).toBe(thread);
    const remoteScoped = scopeThread(remote, thread);
    expect(bareLocalThreadParam(remoteScoped)).toBe(remoteScoped);
    expect(bareLocalThreadParam("")).toBe("");
  });
});

describe("localThreadIdFromKey", () => {
  it("reads a bare key as a local thread and skips other hosts", () => {
    expect(localThreadIdFromKey(thread)).toBe(thread);
    expect(localThreadIdFromKey(scopeLocalThread(thread))).toBe(thread);
    expect(localThreadIdFromKey(scopeThread(remote, thread))).toBeNull();
    expect(localThreadIdFromKey("")).toBeNull();
  });
});
