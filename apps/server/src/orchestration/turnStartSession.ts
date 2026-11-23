import type {
  ModelSelection,
  OrchestrationSession,
  ProviderInstanceId,
  RuntimeMode,
  ThreadId,
} from "@saint/contracts";

export function deriveTurnStartModelSelection(input: {
  readonly currentModelSelection: ModelSelection;
  readonly requestedModelSelection: ModelSelection | undefined;
  readonly canAdoptRequestedProvider: boolean;
}): ModelSelection {
  const requestedModelSelection = input.requestedModelSelection;
  return requestedModelSelection !== undefined &&
    (requestedModelSelection.provider === input.currentModelSelection.provider ||
      input.canAdoptRequestedProvider)
    ? requestedModelSelection
    : input.currentModelSelection;
}

// Sidechats and handoffs import source transcript rows for provider context.
// Those imports must not freeze the first-turn provider the way native history does.
export function countNativeTurnStartMessages(
  messages: ReadonlyArray<{ readonly source?: string | null }>,
): number {
  let count = 0;
  for (const message of messages) {
    if (message.source !== "fork-import" && message.source !== "handoff-import") {
      count += 1;
    }
  }
  return count;
}

export function canAdoptFirstTurnProvider(input: {
  readonly hasLatestTurn: boolean;
  readonly hasSession: boolean;
  readonly messages: ReadonlyArray<{ readonly source?: string | null }>;
}): boolean {
  return (
    !input.hasLatestTurn && !input.hasSession && countNativeTurnStartMessages(input.messages) <= 1
  );
}

export function deriveTurnStartSession(input: {
  readonly threadId: ThreadId;
  readonly currentSession:
    | OrchestrationSession
    | (Omit<OrchestrationSession, "providerInstanceId"> & {
        readonly providerInstanceId: ProviderInstanceId | null;
      })
    | null;
  readonly providerName: OrchestrationSession["providerName"];
  readonly providerInstanceId?: ProviderInstanceId;
  readonly requestedRuntimeMode: RuntimeMode;
  readonly requestedAt: string;
  /**
   * Whether the projected session's provider binding is established (running,
   * ready, or has already produced a turn). A pre-turn optimistic placeholder
   * row can carry a stale provider; when this is false the session's own
   * providerName is ignored in favor of input.providerName.
   */
  readonly sessionProviderEstablished?: boolean;
}): OrchestrationSession | null {
  if (input.currentSession?.status === "starting" || input.currentSession?.status === "running") {
    return null;
  }

  const sessionProviderName =
    input.currentSession?.providerName != null && input.sessionProviderEstablished !== false
      ? input.currentSession.providerName
      : undefined;
  const sessionProviderInstanceId =
    input.currentSession?.providerInstanceId != null && input.sessionProviderEstablished !== false
      ? input.currentSession.providerInstanceId
      : input.providerInstanceId;

  // A session that is already warm and ready for the same provider/instance does
  // not need to drop back into the "starting" ("Starting <Provider>…") phase on
  // every follow-up turn; surface it as running right away and reserve "starting"
  // for cold starts, stopped/errored sessions, or provider/instance switches.
  const sameEstablishedProvider =
    input.currentSession?.status === "ready" &&
    input.sessionProviderEstablished !== false &&
    sessionProviderName === input.providerName &&
    (input.providerInstanceId === undefined ||
      sessionProviderInstanceId === undefined ||
      sessionProviderInstanceId === input.providerInstanceId);

  return {
    threadId: input.threadId,
    status: sameEstablishedProvider ? "running" : "starting",
    providerName: sessionProviderName ?? input.providerName,
    ...(sessionProviderInstanceId !== undefined
      ? { providerInstanceId: sessionProviderInstanceId }
      : {}),
    runtimeMode: input.currentSession?.runtimeMode ?? input.requestedRuntimeMode,
    activeTurnId: null,
    lastError: null,
    updatedAt: input.requestedAt,
  };
}
