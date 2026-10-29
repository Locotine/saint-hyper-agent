import "../index.css";

import { ProjectId, ThreadId } from "@saint/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { sshHostId } from "@saint/shared/hostId";
import { hostStores } from "../hosts/hostStores";
import { ProjectPicker } from "./chat/ProjectPicker";
import { useSpacesUiStore } from "../spacesUiStore";
import { useStore } from "../store";
import { initialState } from "../storeState";
import type { Project, SidebarThreadSummary } from "../types";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { useCreateProjectDialogStore } from "../createProjectDialogStore";

const PROJECT_ID = ProjectId.makeUnsafe("project-picker-saint");
const PROJECT_ROOT = "/Users/tester/projects/saint";
const SELECTED_WORKTREE = "/Users/tester/worktrees/selected/saint";

const project: Project = {
  id: PROJECT_ID,
  kind: "project",
  name: "saint",
  remoteName: "saint",
  folderName: "saint",
  localName: null,
  cwd: PROJECT_ROOT,
  defaultModelSelection: null,
  expanded: true,
  spaceId: null,
  scripts: [],
};

function worktreeThread(id: string, worktreePath: string): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe(id),
    projectId: PROJECT_ID,
    title: "Work on saint",
    modelSelection: { provider: "codex", model: "gpt-5.4" },
    interactionMode: "default",
    envMode: "worktree",
    branch: `feature/${id}`,
    worktreePath,
    session: null,
    createdAt: "2026-10-02T10:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingBackgroundWorkCount: 0,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
  };
}

function setThreads(threads: SidebarThreadSummary[]) {
  useStore.setState({
    threadIds: threads.map((thread) => thread.id),
    sidebarThreadSummaryById: Object.fromEntries(threads.map((thread) => [thread.id, thread])),
  });
}

const clients: QueryClient[] = [];

beforeEach(() => {
  useStore.setState({ ...initialState, projects: [project], threadsHydrated: true });
  useSpacesUiStore.setState({ activeSpaceId: null });
  // Home-directory discovery is independent of the registered-project list.
  useWorkspacePathsStore.setState({ homeDir: null });
});

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  useStore.setState(initialState);
});

async function mountPicker(props: ComponentProps<typeof ProjectPicker> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <ProjectPicker {...props} />
    </QueryClientProvider>,
  );
}

describe("ProjectPicker workspace choices", () => {
  it("lists a registered project once despite its active thread worktrees", async () => {
    setThreads([
      worktreeThread("first", "/Users/tester/worktrees/first/saint"),
      worktreeThread("second", "/Users/tester/worktrees/second/saint"),
      worktreeThread("third", "/Users/tester/worktrees/third/saint"),
    ]);
    const onSelectProject = vi.fn();
    const onSelectWorkspaceRoot = vi.fn();
    const screen = await mountPicker({ onSelectProject, onSelectWorkspaceRoot });

    try {
      await page.getByTestId("workspace-picker-trigger").click();
      await expect.element(page.getByPlaceholder("Search projects")).toBeVisible();
      expect(page.getByRole("option").elements()).toHaveLength(1);

      await page.getByRole("option", { name: "saint", exact: true }).click();
      expect(onSelectProject).toHaveBeenCalledExactlyOnceWith(PROJECT_ID);
      expect(onSelectWorkspaceRoot).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  const dotProjectId = ProjectId.makeUnsafe("project-picker-hermes");
  function addDotProject() {
    useStore.setState({
      projects: [
        project,
        {
          ...project,
          id: dotProjectId,
          name: ".hermes",
          remoteName: ".hermes",
          folderName: ".hermes",
          cwd: "/Users/tester/.hermes",
        },
      ],
    });
  }

  it("lists a registered dot-folder project in the chat workspace picker", async () => {
    addDotProject();
    const onSelectProject = vi.fn();
    const onSelectWorkspaceRoot = vi.fn();
    const screen = await mountPicker({ onSelectProject, onSelectWorkspaceRoot });

    try {
      await page.getByTestId("workspace-picker-trigger").click();
      await page.getByRole("option", { name: ".hermes", exact: true }).click();
      expect(onSelectProject).toHaveBeenCalledExactlyOnceWith(dotProjectId);
      expect(onSelectWorkspaceRoot).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("lists and selects a registered project whose folder starts with a dot", async () => {
    addDotProject();
    const onSelectProject = vi.fn();
    const screen = await mountPicker({
      selectionMode: "project",
      selectedProjectId: dotProjectId,
      onSelectProject,
    });

    try {
      await expect.element(page.getByTestId("project-picker-trigger")).toHaveTextContent(".hermes");
      await page.getByTestId("project-picker-trigger").click();
      await page.getByRole("option", { name: ".hermes", exact: true }).click();
      expect(onSelectProject).toHaveBeenCalledExactlyOnceWith(dotProjectId);
    } finally {
      await screen.unmount();
    }
  });

  it("does not add a project choice when a thread creates another worktree", async () => {
    const screen = await mountPicker();

    try {
      await page.getByTestId("workspace-picker-trigger").click();
      await expect.element(page.getByPlaceholder("Search projects")).toBeVisible();
      expect(page.getByRole("option").elements()).toHaveLength(1);

      setThreads([worktreeThread("new-worktree", "/Users/tester/worktrees/new/saint")]);
      // Reopen after the store update so the assertion observes the updated choices.
      await page.getByTestId("workspace-picker-trigger").click();
      await expect.element(page.getByPlaceholder("Search projects")).not.toBeInTheDocument();
      await page.getByTestId("workspace-picker-trigger").click();
      await expect.element(page.getByPlaceholder("Search projects")).toBeVisible();
      expect(page.getByRole("option").elements()).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the selected worktree available without listing other thread worktrees", async () => {
    setThreads([
      worktreeThread("selected", SELECTED_WORKTREE),
      worktreeThread("other", "/Users/tester/worktrees/other/saint"),
    ]);
    const onSelectProject = vi.fn();
    const onSelectWorkspaceRoot = vi.fn();
    const screen = await mountPicker({
      selectedWorkspaceRoot: SELECTED_WORKTREE,
      onSelectProject,
      onSelectWorkspaceRoot,
    });

    try {
      await expect.element(page.getByTestId("workspace-picker-trigger")).toHaveTextContent("saint");
      await expect
        .element(page.getByTestId("workspace-picker-trigger"))
        .toHaveTextContent(SELECTED_WORKTREE);
      await page.getByTestId("workspace-picker-trigger").click();
      await expect.element(page.getByPlaceholder("Search projects")).toBeVisible();
      expect(page.getByRole("option").elements()).toHaveLength(2);
      await expect
        .element(page.getByRole("option", { name: `saint ${SELECTED_WORKTREE}`, exact: true }))
        .toBeVisible();

      // A raw workspace remains searchable and selectable by its exact path.
      await page.getByPlaceholder("Search projects").fill(SELECTED_WORKTREE);
      await vi.waitFor(() => expect(page.getByRole("option").elements()).toHaveLength(1));
      await page.getByRole("option").click();
      expect(onSelectWorkspaceRoot).toHaveBeenCalledExactlyOnceWith(SELECTED_WORKTREE);
      expect(onSelectProject).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});

describe("ProjectPicker new projects", () => {
  function installNativeApi(overrides: { pickFolder?: () => Promise<string | null> }) {
    const previous = Object.getOwnPropertyDescriptor(window, "nativeApi");
    Object.defineProperty(window, "nativeApi", {
      configurable: true,
      value: {
        dialogs: { pickFolder: overrides.pickFolder ?? (async () => null) },
      },
    });
    return () => {
      if (previous) Object.defineProperty(window, "nativeApi", previous);
      else Reflect.deleteProperty(window, "nativeApi");
    };
  }

  afterEach(() => {
    useCreateProjectDialogStore.setState({ isOpen: false });
  });

  it("opens the shared Create project dialog when there is no folder dialog", async () => {
    const pickFolder = vi.fn(async () => null);
    const restore = installNativeApi({ pickFolder });
    const onCreateProjectFromPath = vi.fn();
    const screen = await mountPicker({
      selectionMode: "project",
      onSelectProject: vi.fn(),
      onCreateProjectFromPath,
    });
    try {
      await page.getByTestId("project-picker-trigger").click();
      await page.getByText("New project").click();
      await vi.waitFor(() => expect(useCreateProjectDialogStore.getState().isOpen).toBe(true));
      expect(onCreateProjectFromPath).not.toHaveBeenCalled();
      await expect.element(page.getByPlaceholder("Search projects")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
      restore();
    }
  });
});

describe("ProjectPicker connected hosts", () => {
  const hostId = sshHostId("abcd1234");
  const hostProject: Project = {
    ...project,
    id: ProjectId.makeUnsafe("project-picker-host-app"),
    name: "app",
    remoteName: "app",
    folderName: "app",
    cwd: "/srv/app",
  };

  function installRemoteBridge() {
    const state = {
      configHosts: [],
      defaultRemoteRoot: ".saint-remote",
      savedHosts: [{ host: "devbox", remoteRoot: null, hostKey: "abcd1234" }],
      hosts: [
        {
          host: "devbox",
          hostKey: "abcd1234",
          epoch: 1,
          remoteRoot: ".saint-remote",
          phase: "connected",
          message: null,
          localPort: 45000,
        },
      ],
    };
    const previous = Object.getOwnPropertyDescriptor(window, "desktopBridge");
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { remoteSsh: { getState: async () => state, onState: () => () => {} } },
    });
    hostStores.get(hostId).setState({ projects: [hostProject] });
    return () => {
      hostStores.get(hostId).setState({ projects: [] });
      if (previous) Object.defineProperty(window, "desktopBridge", previous);
      else Reflect.deleteProperty(window, "desktopBridge");
    };
  }

  it("lists a connected host's projects and starts the thread on that host", async () => {
    const restore = installRemoteBridge();
    const start = vi.fn(async () => {});
    const startInNewProject = vi.fn(async () => {});
    const screen = await mountPicker({
      selectionMode: "project",
      onSelectProject: vi.fn(),
      hostThreads: { start, startInNewProject },
    });
    try {
      await page.getByTestId("project-picker-trigger").click();
      await page.getByRole("option", { name: /app/ }).click();
      expect(start).toHaveBeenCalledExactlyOnceWith(hostId, "devbox", hostProject.id);
    } finally {
      await screen.unmount();
      restore();
    }
  });

  it("offers Add new project on the host", async () => {
    const restore = installRemoteBridge();
    const startInNewProject = vi.fn(async () => {});
    const screen = await mountPicker({
      selectionMode: "project",
      onSelectProject: vi.fn(),
      hostThreads: { start: vi.fn(async () => {}), startInNewProject },
    });
    try {
      await page.getByTestId("project-picker-trigger").click();
      await page.getByText("Add new project on devbox").click();
      await vi.waitFor(() =>
        expect(startInNewProject).toHaveBeenCalledExactlyOnceWith(hostId, "devbox"),
      );
    } finally {
      await screen.unmount();
      restore();
    }
  });
});
