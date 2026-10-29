import { ThreadId } from "@saint/contracts";
import { scopeLocalThread, scopeThread, sshHostId } from "@saint/shared/hostId";
import { describe, expect, it } from "vitest";

import {
  collectCompletedTerminalCandidates,
  collectTerminalAttentionCandidates,
} from "./taskCompletion.logic";

const thread = ThreadId.makeUnsafe("thread-1");
const remote = scopeThread(sshHostId("a1b2c3d4"), thread);

type TerminalState = Parameters<typeof collectCompletedTerminalCandidates>[0][string];

const terminalState = (attentionState?: "attention" | "review"): TerminalState => ({
  runningTerminalIds: [],
  terminalAttentionStatesById: attentionState ? { t1: attentionState } : {},
  terminalCliKindsById: {},
  terminalIds: ["t1"],
  terminalLabelsById: {},
  terminalTitleOverridesById: {},
});
const idle = terminalState();
const review = terminalState("review");
const attention = terminalState("attention");

describe("terminal notifications across hosts", () => {
  it("reports a local terminal under its raw thread id", () => {
    const local = scopeLocalThread(thread);
    expect(collectCompletedTerminalCandidates({ [local]: idle }, { [local]: review })).toEqual([
      expect.objectContaining({ threadId: thread, terminalId: "t1" }),
    ]);
    expect(collectTerminalAttentionCandidates({ [local]: idle }, { [local]: attention })).toEqual([
      expect.objectContaining({ threadId: thread, terminalId: "t1" }),
    ]);
  });

  it("still reads state keyed by a bare thread id as local", () => {
    expect(collectCompletedTerminalCandidates({ [thread]: idle }, { [thread]: review })).toEqual([
      expect.objectContaining({ threadId: thread }),
    ]);
  });

  it("does not notify for another host's terminal until it has a UI", () => {
    expect(collectCompletedTerminalCandidates({ [remote]: idle }, { [remote]: review })).toEqual(
      [],
    );
    expect(collectTerminalAttentionCandidates({ [remote]: idle }, { [remote]: attention })).toEqual(
      [],
    );
  });
});
