import {
  ProjectId,
  ThreadId,
  type ServerConfig,
  type ServerProviderStatus,
} from "@saint/contracts";
import { sshHostId } from "@saint/shared/hostId";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchCommand = vi.fn(async (_command: Record<string, unknown>) => undefined);
let hostProviders: unknown[] = [];
let refreshedHostProviders: unknown[] | null = null;
const refreshProviders = vi.fn(async () => ({
  providers: refreshedHostProviders ?? hostProviders,
}));
let storedSettings = {
  defaultProvider: "claudeAgent" as const as string,
  defaultModel: "claude-opus-5-5",
  defaultEffort: "medium",
  providerOrder: [] as string[],
  hiddenProviders: [] as string[],
};
vi.mock("./hostScope", () => ({
  hostHandle: () => ({
    requireApi: () => ({
      orchestration: {
        dispatchCommand,
        getShellSnapshot: async () => ({
          projects: [
            {
              id: "project-2",
              title: "remote-repo",
              workspaceRoot: "/srv/remote-repo",
              defaultModelSelection: { provider: "claudeAgent", model: "claude-opus-5-5" },
            },
          ],
          threads: [],
        }),
      },
      server: {
        getConfig: async () => ({ providers: hostProviders }),
        refreshProviders,
      },
    }),
    store: {
      getState: () => ({
        projects: [
          { id: "project-1", defaultModelSelection: { provider: "codex", model: "gpt-5" } },
        ],
        threadIds: [],
      }),
    },
  }),
}));
vi.mock("../appSettings", () => ({
  readStoredAppSettings: () => storedSettings,
}));

import { refreshRemoteHostProviderStatuses } from "../lib/serverReactQuery";
import {
  addHostProjectAtPath,
  createHostThread,
  renameHostProject,
  setHostProjectPinned,
  updateHostThreadMeta,
} from "./hostThreadCreate";

const status = (provider: string, available: boolean, overrides: Record<string, unknown> = {}) => ({
  provider,
  instanceId: provider,
  driver: provider,
  available,
  enabled: true,
  status: available ? "ready" : "error",
  authStatus: available ? "authenticated" : "unknown",
  checkedAt: "2026-11-05T00:00:00.000Z",
  ...overrides,
});

const hostId = sshHostId("a1b2c3d4");
const projectId = ProjectId.makeUnsafe("project-1");

beforeEach(() => {
  dispatchCommand.mockClear();
  refreshProviders.mockClear();
  hostProviders = [];
  refreshedHostProviders = null;
  storedSettings = {
    defaultProvider: "claudeAgent",
    defaultModel: "claude-opus-5-5",
    defaultEffort: "medium",
    providerOrder: [],
    hiddenProviders: [],
  };
});

describe("host project commands", () => {
  it("renames a project on the host through project.meta.update", async () => {
    await renameHostProject(hostId, projectId, "Renamed");
    expect(dispatchCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "project.meta.update", projectId, title: "Renamed" }),
    );
  });

  it("pins and unpins a project on the host", async () => {
    await setHostProjectPinned(hostId, projectId, true);
    expect(dispatchCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "project.meta.update", projectId, isPinned: true }),
    );
    await setHostProjectPinned(hostId, projectId, false);
    expect(dispatchCommand).toHaveBeenLastCalledWith(expect.objectContaining({ isPinned: false }));
  });
});

describe("host thread commands", () => {
  it("renames and pins a thread on the host through thread.meta.update", async () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    await updateHostThreadMeta(hostId, threadId, { title: "Renamed" });
    expect(dispatchCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "thread.meta.update", threadId, title: "Renamed" }),
    );
    await updateHostThreadMeta(hostId, threadId, { isPinned: true });
    expect(dispatchCommand).toHaveBeenLastCalledWith(expect.objectContaining({ isPinned: true }));
  });
});

describe("createHostThread", () => {
  it("starts with Settings' default provider when the host has it", async () => {
    hostProviders = [status("codex", true), status("claudeAgent", true)];
    await createHostThread(hostId, projectId);
    expect(dispatchCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        modelSelection: expect.objectContaining({ provider: "claudeAgent" }),
      }),
    );
  });

  it("falls back to the provider the host has when it lacks the default one", async () => {
    hostProviders = [status("codex", true), status("claudeAgent", false)];
    await createHostThread(hostId, projectId);
    expect(dispatchCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ modelSelection: expect.objectContaining({ provider: "codex" }) }),
    );
  });

  it("refreshes a cold remote host (disabled-only config) and picks Claude over a 1.1.12 codex default", async () => {
    storedSettings = {
      defaultProvider: "codex",
      defaultModel: "claude-opus-5-5",
      defaultEffort: "medium",
      providerOrder: ["codex", "claudeAgent"],
      hiddenProviders: ["claudeAgent"],
    };
    // A newly booted remote SSH server (SAINT_PROVIDERS=codex,claudeAgent) projects
    // only disabled non-allowlisted providers until providerHealth.refresh runs.
    hostProviders = [
      status("cursor", false, { enabled: false }),
      status("antigravity", false, { enabled: false }),
    ];
    refreshedHostProviders = [
      status("codex", false),
      status("claudeAgent", true),
      status("cursor", false, { enabled: false }),
    ];

    await createHostThread(hostId, projectId);

    expect(refreshProviders).toHaveBeenCalledTimes(1);
    expect(dispatchCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "thread.create",
        modelSelection: expect.objectContaining({ provider: "claudeAgent" }),
      }),
    );
    const createdCommand = dispatchCommand.mock.lastCall?.[0] as
      | { modelSelection?: { model?: string } }
      | undefined;
    expect(createdCommand?.modelSelection?.model).toBeTruthy();
    expect(createdCommand?.modelSelection?.model).not.toMatch(/^gpt-/i);
  });

  it("seeds a new remote project with Claude when getConfig has no probed enabled providers yet", async () => {
    storedSettings = {
      defaultProvider: "codex",
      defaultModel: "gpt-5.4",
      defaultEffort: "medium",
      providerOrder: [],
      hiddenProviders: [],
    };
    hostProviders = [];
    refreshedHostProviders = [status("codex", false), status("claudeAgent", true)];

    await addHostProjectAtPath(hostId, "/srv/remote-repo");

    expect(refreshProviders).toHaveBeenCalledTimes(1);
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "project.create",
        defaultModelSelection: expect.objectContaining({ provider: "claudeAgent" }),
      }),
    );
  });

  it("awaits an in-flight connect-time provider refresh before choosing the remote provider", async () => {
    storedSettings = {
      defaultProvider: "codex",
      defaultModel: "gpt-5.4",
      defaultEffort: "medium",
      providerOrder: [],
      hiddenProviders: [],
    };
    // Stale getConfig on disk claimed codex was available, while the live connect
    // refresh discovers only claudeAgent is installed.
    hostProviders = [status("codex", true), status("claudeAgent", true)];
    let resolveRefresh!: (value: { providers: ServerProviderStatus[] }) => void;
    const remoteHostId = sshHostId("b2c3d4e5");
    const queryClient = new QueryClient();
    const connectRefresh = refreshRemoteHostProviderStatuses(queryClient, remoteHostId, {
      api: {
        server: {
          refreshProviders: () =>
            new Promise((resolve) => {
              resolveRefresh = resolve;
            }),
          getConfig: async () =>
            ({
              cwd: "/srv",
              homeDir: "/home/dev",
              chatWorkspaceRoot: "/home/dev/Documents/Saint",
              studioWorkspaceRoot: "/home/dev/Documents/Saint/Studio",
              groupsWorkspaceRoot: "/home/dev/Documents/Saint/Groups",
              worktreesDir: "/home/dev/.saint-remote/worktrees",
              keybindingsConfigPath: "/home/dev/.saint-remote/keybindings.json",
              keybindings: [],
              issues: [],
              providers: [],
              availableEditors: [],
            }) satisfies ServerConfig,
        },
      } as never,
    });

    const createPromise = createHostThread(remoteHostId, projectId);
    resolveRefresh({
      providers: [
        status("codex", false) as ServerProviderStatus,
        status("claudeAgent", true) as ServerProviderStatus,
      ],
    });
    await Promise.all([connectRefresh, createPromise]);

    expect(dispatchCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "thread.create",
        modelSelection: expect.objectContaining({ provider: "claudeAgent" }),
      }),
    );
  });
});
