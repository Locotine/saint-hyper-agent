// FILE: openPathInThreadTerminal.ts
// Purpose: Opens a thread's terminal drawer at a folder: starts a shell there, or `cd`s the
//          one that is open. Shared by this computer's thread menu and a remote host's.
// Layer: Web helper
// Exports: openPathInThreadTerminal

import type { NativeApi, ThreadId } from "@saint/contracts";
import type { ScopedThreadId } from "@saint/shared/hostId";

import { toastManager } from "~/components/ui/toast";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { quotePosixShellArgument } from "./shellQuote";

/** `api` is the API of the machine the folder is on; `scopedThreadId` keys the terminal state. */
export async function openPathInThreadTerminal(input: {
  api: Pick<NativeApi, "terminal">;
  scopedThreadId: ScopedThreadId;
  threadId: ThreadId;
  path: string;
}): Promise<void> {
  const { api, scopedThreadId, threadId, path } = input;
  const terminalStore = useTerminalStateStore.getState();
  const currentTerminalState = selectThreadTerminalState(
    terminalStore.terminalStateByThreadId,
    scopedThreadId,
  );

  const targetTerminalId = currentTerminalState.activeTerminalId;
  if (currentTerminalState.runningTerminalIds.includes(targetTerminalId)) {
    toastManager.add({
      type: "error",
      title: "Terminal is busy",
      description: "Stop its command before opening another path.",
    });
    return;
  }
  const shouldCreateNewTerminal = !currentTerminalState.terminalOpen;

  const previousTerminalOpen = currentTerminalState.terminalOpen;
  const previousPresentationMode = currentTerminalState.presentationMode;
  const previousActiveTerminalId = currentTerminalState.activeTerminalId;

  terminalStore.setTerminalPresentationMode(scopedThreadId, "workspace");
  terminalStore.setTerminalOpen(scopedThreadId, true);
  terminalStore.setActiveTerminal(scopedThreadId, targetTerminalId);

  const cdCommand = `cd ${quotePosixShellArgument(path)}\r`;
  try {
    if (shouldCreateNewTerminal) {
      // A brand new PTY needs an explicit cwd so that the shell's first
      // prompt already shows the workspace path. The follow-up `cd` write
      // makes the navigation visible in the scrollback (it's effectively
      // a no-op since the shell is already there, but it matches the
      // user-typed-it experience).
      await api.terminal.open({ threadId, terminalId: targetTerminalId, cwd: path });
    }
    // Existing PTYs keep their launch cwd/env on reattach; writing `cd`
    // navigates in place without replacing shell state.
    await api.terminal.write({
      threadId,
      terminalId: targetTerminalId,
      data: cdCommand,
      onlyIfIdle: true,
    });
  } catch (error) {
    // Open may already have created a PTY, even if navigation or its
    // acknowledgement failed. Keep its identity available for reattach.
    terminalStore.setTerminalPresentationMode(scopedThreadId, previousPresentationMode);
    terminalStore.setTerminalOpen(scopedThreadId, previousTerminalOpen);
    if (previousActiveTerminalId) {
      terminalStore.setActiveTerminal(scopedThreadId, previousActiveTerminalId);
    }
    toastManager.add({
      type: "error",
      title: "Unable to open terminal",
      description: error instanceof Error ? error.message : "The terminal could not be opened.",
    });
  }
}
