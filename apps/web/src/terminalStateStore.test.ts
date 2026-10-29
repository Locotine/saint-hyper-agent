import { LOCAL_HOST_ID, scopeLocalThread, scopeThread, sshHostId } from "@saint/shared/hostId";
import { ThreadId } from "@saint/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  sanitizePersistedTerminalStateByThreadId,
  selectThreadTerminalState,
  useTerminalStateStore,
} from "./terminalStateStore";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

describe("terminalStateStore actions", () => {
  beforeEach(() => {
    useTerminalStateStore.setState({ terminalStateByThreadId: {} });
  });

  it("returns a closed default terminal state for unknown threads", () => {
    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      scopeLocalThread(THREAD_ID),
    );
    expect(terminalState).toMatchObject({
      entryPoint: "chat",
      terminalOpen: false,
      presentationMode: "workspace",
      workspaceLayout: "both",
      workspaceActiveTab: "terminal",
      terminalIds: ["default"],
      terminalLabelsById: { default: "Terminal 1" },
      terminalTitleOverridesById: {},
      terminalCliKindsById: {},
      terminalAttentionStatesById: {},
      runningTerminalIds: [],
      activeTerminalId: "default",
    });
  });

  it("marks chat-first threads without forcing open terminal UI", () => {
    const store = useTerminalStateStore.getState();
    store.openTerminalThreadPage(scopeLocalThread(THREAD_ID), { terminalOnly: true });
    store.openChatThreadPage(scopeLocalThread(THREAD_ID));

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      scopeLocalThread(THREAD_ID),
    );
    expect(terminalState.entryPoint).toBe("chat");
    expect(terminalState.workspaceLayout).toBe("both");
    expect(terminalState.workspaceActiveTab).toBe("chat");
  });

  it("opens terminal-first threads in the workspace terminal tab", () => {
    const store = useTerminalStateStore.getState();
    store.openTerminalThreadPage(scopeLocalThread(THREAD_ID), { terminalOnly: true });

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      scopeLocalThread(THREAD_ID),
    );
    expect(terminalState.entryPoint).toBe("terminal");
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.presentationMode).toBe("workspace");
    expect(terminalState.workspaceLayout).toBe("terminal-only");
    expect(terminalState.workspaceActiveTab).toBe("terminal");
  });

  it("restores the last-used presentation mode when reopened", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalPresentationMode(scopeLocalThread(THREAD_ID), "workspace");
    store.setTerminalOpen(scopeLocalThread(THREAD_ID), false);
    store.setTerminalOpen(scopeLocalThread(THREAD_ID), true);

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      scopeLocalThread(THREAD_ID),
    );
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.presentationMode).toBe("workspace");
  });

  it("enters workspace mode on the terminal tab by default", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalPresentationMode(scopeLocalThread(THREAD_ID), "workspace");
    store.setTerminalWorkspaceTab(scopeLocalThread(THREAD_ID), "chat");
    store.setTerminalPresentationMode(scopeLocalThread(THREAD_ID), "drawer");
    store.setTerminalPresentationMode(scopeLocalThread(THREAD_ID), "workspace");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      scopeLocalThread(THREAD_ID),
    );
    expect(terminalState.presentationMode).toBe("workspace");
    expect(terminalState.workspaceActiveTab).toBe("terminal");
  });

  it("opens a new full-width terminal in terminal-only workspace mode", () => {
    const store = useTerminalStateStore.getState();
    store.openNewFullWidthTerminal(scopeLocalThread(THREAD_ID));

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      scopeLocalThread(THREAD_ID),
    );
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.presentationMode).toBe("workspace");
    expect(terminalState.workspaceLayout).toBe("terminal-only");
    expect(terminalState.workspaceActiveTab).toBe("terminal");
    expect(terminalState.activeTerminalId).toBe("default");
    expect(terminalState.terminalIds).toEqual(["default"]);
  });

  it("restores chat when selecting the chat workspace tab from terminal-only mode", () => {
    const store = useTerminalStateStore.getState();
    store.openNewFullWidthTerminal(scopeLocalThread(THREAD_ID));
    store.setTerminalWorkspaceTab(scopeLocalThread(THREAD_ID), "chat");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      scopeLocalThread(THREAD_ID),
    );
    expect(terminalState.workspaceLayout).toBe("both");
    expect(terminalState.workspaceActiveTab).toBe("chat");
  });

  it("closes workspace chat into terminal-only mode without closing terminals", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalPresentationMode(scopeLocalThread(THREAD_ID), "workspace");
    store.setTerminalWorkspaceTab(scopeLocalThread(THREAD_ID), "chat");
    store.closeWorkspaceChat(scopeLocalThread(THREAD_ID));

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      scopeLocalThread(THREAD_ID),
    );
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.presentationMode).toBe("workspace");
    expect(terminalState.workspaceLayout).toBe("terminal-only");
    expect(terminalState.workspaceActiveTab).toBe("terminal");
    expect(terminalState.terminalIds).toEqual(["default"]);
  });

  it("maps legacy drawer requests to the single workspace panel", () => {
    const store = useTerminalStateStore.getState();
    store.openNewFullWidthTerminal(scopeLocalThread(THREAD_ID));
    store.setTerminalPresentationMode(scopeLocalThread(THREAD_ID), "drawer");
    store.setTerminalPresentationMode(scopeLocalThread(THREAD_ID), "workspace");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      scopeLocalThread(THREAD_ID),
    );
    expect(terminalState.presentationMode).toBe("workspace");
    expect(terminalState.workspaceLayout).toBe("terminal-only");
    expect(terminalState.workspaceActiveTab).toBe("terminal");
  });

  it("reuses the single terminal when opened repeatedly", () => {
    const store = useTerminalStateStore.getState();
    store.openTerminalThreadPage(scopeLocalThread(THREAD_ID));
    store.openNewFullWidthTerminal(scopeLocalThread(THREAD_ID));
    store.newTerminal(scopeLocalThread(THREAD_ID), "also-unused");
    const state = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      scopeLocalThread(THREAD_ID),
    );
    expect(state.terminalIds).toEqual(["default"]);
    expect(state.activeTerminalId).toBe("default");
  });

  it("retains the session while hidden and reuses it on another open request", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalOpen(scopeLocalThread(THREAD_ID), true);
    store.setTerminalOpen(scopeLocalThread(THREAD_ID), false);
    expect(
      useTerminalStateStore.getState().terminalStateByThreadId[scopeLocalThread(THREAD_ID)]
        ?.hasSession,
    ).toBe(true);
    store.newTerminal(scopeLocalThread(THREAD_ID), "unused");
    const state = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      scopeLocalThread(THREAD_ID),
    );
    expect(state.activeTerminalId).toBe("default");
    expect(state.terminalIds).toEqual(["default"]);
  });

  it("restores only the active legacy session and retains other ids until cleanup succeeds", () => {
    const initial = selectThreadTerminalState({}, scopeLocalThread(THREAD_ID));
    const state = sanitizePersistedTerminalStateByThreadId({
      [THREAD_ID]: {
        ...initial,
        terminalOpen: true,
        terminalIds: ["old-left", "old-right"],
        activeTerminalId: "old-right",
        terminalLabelsById: { "old-left": "Left", "old-right": "Right" },
      },
    });
    expect(state[scopeLocalThread(THREAD_ID)]?.terminalIds).toEqual(["old-right"]);
    expect(state[scopeLocalThread(THREAD_ID)]?.activeTerminalId).toBe("old-right");
    expect(state[scopeLocalThread(THREAD_ID)]?.retiredTerminalIds).toEqual(["old-left"]);
    useTerminalStateStore.setState({ terminalStateByThreadId: state });
    useTerminalStateStore.getState().forgetRetiredTerminal(scopeLocalThread(THREAD_ID), "old-left");
    expect(
      useTerminalStateStore.getState().terminalStateByThreadId[scopeLocalThread(THREAD_ID)]
        ?.retiredTerminalIds,
    ).toEqual([]);
  });

  it("stores terminal labels and removes them when a terminal closes", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(scopeLocalThread(THREAD_ID), "terminal-2");
    store.setTerminalMetadata(scopeLocalThread(THREAD_ID), "terminal-2", {
      cliKind: "codex",
      label: "Codex CLI",
    });

    let terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      scopeLocalThread(THREAD_ID),
    );
    expect(terminalState.terminalLabelsById).toEqual({
      "terminal-2": "Codex 1",
    });
    expect(terminalState.terminalCliKindsById).toEqual({ "terminal-2": "codex" });

    store.closeTerminal(scopeLocalThread(THREAD_ID), "terminal-2");

    terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      scopeLocalThread(THREAD_ID),
    );
    expect(terminalState.terminalLabelsById).toEqual({
      [terminalState.activeTerminalId]: "Terminal 1",
    });
    expect(terminalState.terminalCliKindsById).toEqual({});
  });

  it("clears terminal provider identity when metadata cliKind is null", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(scopeLocalThread(THREAD_ID), "terminal-2");
    store.setTerminalMetadata(scopeLocalThread(THREAD_ID), "terminal-2", {
      cliKind: "codex",
      label: "Codex CLI",
    });
    store.setTerminalMetadata(scopeLocalThread(THREAD_ID), "terminal-2", {
      cliKind: null,
      label: "bun dev",
    });

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      scopeLocalThread(THREAD_ID),
    );
    expect(terminalState.terminalLabelsById["terminal-2"]).toBe("bun dev");
    expect(terminalState.terminalCliKindsById).toEqual({});
  });

  it("tracks and clears terminal subprocess activity", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(scopeLocalThread(THREAD_ID), "terminal-2");
    store.setTerminalActivity(scopeLocalThread(THREAD_ID), "terminal-2", {
      hasRunningSubprocess: true,
      agentState: null,
    });
    expect(
      selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadId,
        scopeLocalThread(THREAD_ID),
      ).runningTerminalIds,
    ).toEqual(["terminal-2"]);

    store.setTerminalActivity(scopeLocalThread(THREAD_ID), "terminal-2", {
      hasRunningSubprocess: false,
      agentState: null,
    });
    expect(
      selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadId,
        scopeLocalThread(THREAD_ID),
      ).runningTerminalIds,
    ).toEqual([]);
  });

  it("strips volatile runtime flags from persisted terminal state", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(scopeLocalThread(THREAD_ID), "terminal-2");
    store.setTerminalTitleOverride(scopeLocalThread(THREAD_ID), "terminal-2", "New keybinds set");
    store.setTerminalActivity(scopeLocalThread(THREAD_ID), "terminal-2", {
      hasRunningSubprocess: false,
      agentState: "attention",
    });

    const sanitized = sanitizePersistedTerminalStateByThreadId(
      useTerminalStateStore.getState().terminalStateByThreadId,
    );

    expect(sanitized[scopeLocalThread(THREAD_ID)]?.terminalTitleOverridesById).toEqual({
      "terminal-2": "New keybinds set",
    });
    expect(sanitized[scopeLocalThread(THREAD_ID)]?.terminalAttentionStatesById).toEqual({});
    expect(sanitized[scopeLocalThread(THREAD_ID)]?.runningTerminalIds).toEqual([]);
  });

  it("drops retired standalone workspace terminal scopes", () => {
    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      scopeLocalThread(THREAD_ID),
    );

    expect(
      sanitizePersistedTerminalStateByThreadId({
        ["workspace:legacy" as ThreadId]: {
          ...terminalState,
          terminalOpen: true,
        },
      }),
    ).toEqual({});
  });

  it("reads v1 state keyed by a bare thread id as this computer's thread", () => {
    const terminalState = {
      ...selectThreadTerminalState({}, scopeLocalThread(THREAD_ID)),
      terminalOpen: true,
    };
    const remote = scopeThread(sshHostId("a1b2c3d4"), THREAD_ID);

    const sanitized = sanitizePersistedTerminalStateByThreadId({
      [THREAD_ID as string]: terminalState,
      [remote]: terminalState,
    } as never);

    expect(Object.keys(sanitized).toSorted()).toEqual(
      [scopeLocalThread(THREAD_ID), remote].toSorted(),
    );
  });

  it("reserves a fresh identity without opening a replacement when closing the last terminal", () => {
    const store = useTerminalStateStore.getState();
    store.closeTerminal(scopeLocalThread(THREAD_ID), "default");

    const state = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      scopeLocalThread(THREAD_ID),
    );
    expect(state.terminalOpen).toBe(false);
    expect(state.hasSession).toBe(false);
    expect(state.activeTerminalId).not.toBe("default");
    expect(state.terminalIds).toEqual([state.activeTerminalId]);
  });

  it("uses a new identity after close, including hydration, and ignores the old exit", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalOpen(scopeLocalThread(THREAD_ID), true);
    store.closeTerminal(scopeLocalThread(THREAD_ID), "default");
    const hydrated = sanitizePersistedTerminalStateByThreadId(
      useTerminalStateStore.getState().terminalStateByThreadId,
    );
    useTerminalStateStore.setState({ terminalStateByThreadId: hydrated });
    store.setTerminalOpen(scopeLocalThread(THREAD_ID), true);
    const reopened =
      useTerminalStateStore.getState().terminalStateByThreadId[scopeLocalThread(THREAD_ID)]!;
    expect(reopened.activeTerminalId).not.toBe("default");
    expect(store.closeExitedTerminal(scopeLocalThread(THREAD_ID), "default")).toBe("ignored");
    expect(
      useTerminalStateStore.getState().terminalStateByThreadId[scopeLocalThread(THREAD_ID)]
        ?.terminalOpen,
    ).toBe(true);
  });

  it("keeps terminal-first threads terminal-first after closing the last terminal", () => {
    const store = useTerminalStateStore.getState();
    store.openTerminalThreadPage(scopeLocalThread(THREAD_ID), { terminalOnly: true });
    store.closeTerminal(scopeLocalThread(THREAD_ID), "default");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      scopeLocalThread(THREAD_ID),
    );
    expect(
      useTerminalStateStore.getState().terminalStateByThreadId[scopeLocalThread(THREAD_ID)],
    ).toBeDefined();
    expect(terminalState.entryPoint).toBe("terminal");
    expect(terminalState.terminalOpen).toBe(false);
    expect(terminalState.terminalIds).toEqual([terminalState.activeTerminalId]);
    expect(terminalState.activeTerminalId).not.toBe("default");
  });

  it("closes the only session without replacing it and ignores late exits", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(scopeLocalThread(THREAD_ID), "session");
    expect(store.closeExitedTerminal(scopeLocalThread(THREAD_ID), "session")).toBe("final");
    expect(store.closeExitedTerminal(scopeLocalThread(THREAD_ID), "session")).toBe("ignored");
    expect(
      selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadId,
        scopeLocalThread(THREAD_ID),
      ).terminalOpen,
    ).toBe(false);
  });
});

describe("dock terminal sessions", () => {
  it("adopts the existing session once, persists independent pane sessions, and closes only the target", () => {
    useTerminalStateStore.setState({ terminalStateByThreadId: {} });
    const scopeId = ThreadId.makeUnsafe("dock-terminal:host");
    const store = useTerminalStateStore.getState();
    store.newTerminal(scopeLocalThread(scopeId), "legacy-session");
    store.ensureDockTerminal(scopeLocalThread(scopeId), "pane-a");
    store.ensureDockTerminal(scopeLocalThread(scopeId), "pane-b");
    const state = () =>
      useTerminalStateStore.getState().terminalStateByThreadId[scopeLocalThread(scopeId)]!;
    const first = state().dockTerminalIdsByPaneId!["pane-a"]!;
    const second = state().dockTerminalIdsByPaneId!["pane-b"]!;
    expect(first).toBe("legacy-session");
    expect(second).not.toBe(first);
    store.setTerminalActivity(scopeLocalThread(scopeId), first, {
      hasRunningSubprocess: true,
      agentState: null,
    });
    store.setTerminalTitleOverride(scopeLocalThread(scopeId), second, "Server");
    store.ensureDockTerminal(scopeLocalThread(scopeId), "pane-a");
    expect(state().terminalIds).toEqual([first, second]);
    expect(state().runningTerminalIds).toEqual([first]);

    useTerminalStateStore.setState({
      terminalStateByThreadId: sanitizePersistedTerminalStateByThreadId(
        useTerminalStateStore.getState().terminalStateByThreadId,
      ),
    });
    expect(state().dockTerminalIdsByPaneId).toEqual({ "pane-a": first, "pane-b": second });
    expect(state().terminalTitleOverridesById[second]).toBe("Server");
    expect(state().retiredTerminalIds ?? []).toEqual([]);
    store.closeTerminal(scopeLocalThread(scopeId), first);
    expect(state().terminalIds).toEqual([second]);
    expect(state().dockTerminalIdsByPaneId).toEqual({ "pane-b": second });
    expect(state().terminalOpen).toBe(true);
    expect(store.closeExitedTerminal(scopeLocalThread(scopeId), first)).toBe("ignored");
    expect(store.closeExitedTerminal(scopeLocalThread(scopeId), second)).toBe("final");
    expect(state().terminalOpen).toBe(false);
  });
});

describe("terminalStateStore per-host state", () => {
  const remoteHost = sshHostId("a1b2c3d4");
  const localId = scopeLocalThread(THREAD_ID);
  const remoteId = scopeThread(remoteHost, THREAD_ID);

  beforeEach(() => {
    useTerminalStateStore.setState({ terminalStateByThreadId: {} });
  });

  it("keeps the same raw thread id on two hosts as two entries", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalOpen(localId, true);
    store.openTerminalThreadPage(remoteId);

    const byThread = useTerminalStateStore.getState().terminalStateByThreadId;
    expect(byThread[localId]?.entryPoint).toBe("chat");
    expect(byThread[remoteId]?.entryPoint).toBe("terminal");
  });

  it("drops orphaned state for one host only", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalOpen(localId, true);
    store.setTerminalOpen(remoteId, true);

    useTerminalStateStore.getState().removeOrphanedTerminalStates(LOCAL_HOST_ID, new Set());

    const byThread = useTerminalStateStore.getState().terminalStateByThreadId;
    expect(byThread[localId]).toBeUndefined();
    expect(byThread[remoteId]).toBeDefined();
  });

  it("keeps a host's state for threads its snapshot still lists", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalOpen(remoteId, true);

    store.removeOrphanedTerminalStates(remoteHost, new Set([THREAD_ID]));
    expect(useTerminalStateStore.getState().terminalStateByThreadId[remoteId]).toBeDefined();

    store.removeOrphanedTerminalStates(remoteHost, new Set());
    expect(useTerminalStateStore.getState().terminalStateByThreadId[remoteId]).toBeUndefined();
  });

  it("reads state saved under a raw thread id as this computer's and keeps scoped keys", () => {
    const open = { ...selectThreadTerminalState({}, localId), terminalOpen: true };
    const hydrated = sanitizePersistedTerminalStateByThreadId({
      [THREAD_ID]: open,
      [remoteId]: open,
    } as never);

    expect(Object.keys(hydrated).toSorted()).toEqual([localId, remoteId].toSorted());
  });
});
