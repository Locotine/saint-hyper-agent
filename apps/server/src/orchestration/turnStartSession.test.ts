import { ThreadId, type OrchestrationSession } from "@saint/contracts";
import { describe, expect, it } from "vitest";

import { canAdoptFirstTurnProvider, deriveTurnStartSession } from "./turnStartSession.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-turn-start-session");
const REQUESTED_AT = "2026-07-21T00:00:00.000Z";

function makeSession(status: OrchestrationSession["status"]): OrchestrationSession {
  return {
    threadId: THREAD_ID,
    status,
    providerName: "codex",
    providerInstanceId: "codex",
    runtimeMode: "approval-required",
    activeTurnId: null,
    lastError: status === "error" ? "runtime exploded" : null,
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
}

function derive(
  currentSession: OrchestrationSession | null,
  overrides?: {
    readonly providerName?: OrchestrationSession["providerName"];
    readonly providerInstanceId?: OrchestrationSession["providerInstanceId"];
  },
) {
  return deriveTurnStartSession({
    threadId: THREAD_ID,
    currentSession,
    providerName: overrides?.providerName ?? "pi",
    ...(overrides?.providerInstanceId !== undefined
      ? { providerInstanceId: overrides.providerInstanceId }
      : {}),
    requestedRuntimeMode: "full-access",
    requestedAt: REQUESTED_AT,
  });
}

describe("deriveTurnStartSession", () => {
  it("ignores imported history when deciding first-turn provider adoption", () => {
    expect(
      canAdoptFirstTurnProvider({
        hasLatestTurn: false,
        hasSession: false,
        messages: [{ source: "fork-import" }, { source: "handoff-import" }, { source: "native" }],
      }),
    ).toBe(true);

    expect(
      canAdoptFirstTurnProvider({
        hasLatestTurn: false,
        hasSession: false,
        messages: [{ source: "fork-import" }, { source: "native" }, { source: "native" }],
      }),
    ).toBe(false);

    expect(
      canAdoptFirstTurnProvider({
        hasLatestTurn: true,
        hasSession: false,
        messages: [{ source: "fork-import" }],
      }),
    ).toBe(false);
  });

  it("preserves established provider settings and avoids starting phase for warm ready sessions", () => {
    expect(derive(makeSession("ready"), { providerName: "codex" })).toMatchObject({
      status: "running",
      providerName: "codex",
      runtimeMode: "approval-required",
      activeTurnId: null,
      lastError: null,
    });
  });

  it("uses starting phase when restarting an idle ready session onto a different provider", () => {
    expect(derive(makeSession("ready"))).toMatchObject({
      status: "starting",
      providerName: "codex",
      runtimeMode: "approval-required",
      activeTurnId: null,
      lastError: null,
    });
  });

  it("uses starting phase when a session is stopped or absent", () => {
    expect(derive(makeSession("stopped"), { providerName: "codex" })).toMatchObject({
      status: "starting",
      providerName: "codex",
      activeTurnId: null,
      lastError: null,
    });
    expect(derive(null, { providerName: "codex" })).toMatchObject({
      status: "starting",
      providerName: "codex",
      activeTurnId: null,
      lastError: null,
    });
  });

  it.each(["starting", "running"] as const)("does not replace a %s session", (status) => {
    expect(derive(makeSession(status))).toBeNull();
  });

  it("clears terminal error details when a new turn starts", () => {
    expect(derive(makeSession("error"))).toMatchObject({
      status: "starting",
      activeTurnId: null,
      lastError: null,
    });
  });
});
