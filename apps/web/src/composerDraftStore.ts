// FILE: composerDraftStore.ts
// Purpose: Public Zustand facade for composer drafts, model choices, attachments, and persistence.
// Exports: Stable composer draft API, hooks, and promotion helpers.

import { scopeThread, unscopeThread, type HostId, type ScopedThreadId } from "@saint/shared/hostId";
import {
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderKind,
  type ThreadId,
} from "@saint/contracts";
import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";

import { createComposerDraftStoreState } from "./composerDraftActions";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  LEGACY_COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_VERSION,
  composerThreadDraftIsPending,
  composerThreadDraftPreviewText,
  selectComposerThreadDraft,
  selectThreadIdsWithPendingDraft,
  type ComposerDraftStoreState,
  type ComposerThreadDraftState,
} from "./composerDraftDomain";
import {
  deriveEffectiveComposerModelState,
  type EffectiveComposerModelState,
} from "./composerDraftModels";
import {
  migratePersistedComposerDraftStoreState,
  normalizeCurrentPersistedComposerDraftStoreState,
  partializeComposerDraftStoreState,
  toHydratedThreadDraft,
  type PersistedComposerDraftStoreState,
} from "./composerDraftPersistence";
import {
  createDeferredPersistStorage,
  createMemoryStorage,
  flushStorageBeforePageHide,
  withLegacyKeyFallback,
  type StateStorage,
} from "./lib/storage";

export {
  findSupersededComposerImageBlobAttachments,
  isComposerImageBlobReferenced,
} from "./composerDraftAttachments";
export {
  captureComposerPromptHistorySavedDraft,
  composerThreadDraftIsPending,
  COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_VERSION,
  PersistedComposerImageAttachment,
} from "./composerDraftDomain";
export type {
  ComposerAssistantSelectionAttachment,
  ComposerAttachmentPersistenceResult,
  ComposerDraftStoreState,
  ComposerFileAttachment,
  ComposerImageAttachment,
  ComposerPromptHistorySavedDraft,
  ComposerThreadDraftState,
  DraftThreadEnvMode,
  DraftThreadState,
  QueuedComposerChatTurn,
  QueuedComposerPlanFollowUp,
  QueuedComposerTurn,
  RestoredComposerSourceProposedPlan,
} from "./composerDraftDomain";
export type { BrowserAnnotationDraft } from "./lib/browserAnnotations";
export {
  deriveEffectiveComposerModelState,
  providerInstanceModelSelectionKey,
  resolvePreferredComposerModelSelection,
} from "./composerDraftModels";
export type { EffectiveComposerModelState } from "./composerDraftModels";
export { partializeComposerDraftStoreState } from "./composerDraftPersistence";

const COMPOSER_PERSIST_DEBOUNCE_MS = 300;
const composerBaseStorage: StateStorage =
  typeof localStorage !== "undefined"
    ? withLegacyKeyFallback(localStorage, LEGACY_COMPOSER_DRAFT_STORAGE_KEY)
    : createMemoryStorage();
const composerPersistStorage = createDeferredPersistStorage<
  ComposerDraftStoreState,
  PersistedComposerDraftStoreState
>({
  getStorage: () => composerBaseStorage,
  partialize: partializeComposerDraftStoreState,
  debounceMs: COMPOSER_PERSIST_DEBOUNCE_MS,
});

// Flush pending composer draft writes before the page goes away so at most one
// debounce window of changes can be lost.
flushStorageBeforePageHide(() => composerPersistStorage.flush());

export const useComposerDraftStore = create<ComposerDraftStoreState>()(
  persist(
    createComposerDraftStoreState(() => composerPersistStorage.flush()),
    {
      name: COMPOSER_DRAFT_STORAGE_KEY,
      version: COMPOSER_DRAFT_STORAGE_VERSION,
      // Partialization is owned by deferred storage so serialization does not run
      // on each keystroke and instead happens once per 300ms flush window.
      storage: composerPersistStorage,
      migrate: migratePersistedComposerDraftStoreState,
      merge: (persistedState, currentState) => {
        const normalizedPersisted =
          normalizeCurrentPersistedComposerDraftStoreState(persistedState);
        const draftsByThreadId = Object.fromEntries(
          Object.entries(normalizedPersisted.draftsByThreadId).map(([threadId, draft]) => [
            threadId,
            toHydratedThreadDraft(threadId as ScopedThreadId, draft),
          ]),
        );
        return {
          ...currentState,
          draftsByThreadId,
          draftThreadsByThreadId: normalizedPersisted.draftThreadsByThreadId,
          projectDraftThreadIdByProjectId: normalizedPersisted.projectDraftThreadIdByProjectId,
          stickyModelSelectionByProvider: normalizedPersisted.stickyModelSelectionByProvider ?? {},
          stickyActiveProvider: normalizedPersisted.stickyActiveProvider ?? null,
        };
      },
    },
  ),
);

export function useComposerThreadDraft(threadId: ScopedThreadId): ComposerThreadDraftState {
  return useComposerDraftStore((state) => selectComposerThreadDraft(state, threadId));
}

export function useThreadHasPendingDraft(threadId: ScopedThreadId): boolean {
  return useComposerDraftStore((state) => {
    const draft = state.draftsByThreadId[threadId];
    return draft !== undefined && composerThreadDraftIsPending(draft);
  });
}

/** Short excerpt of the chat's unsent prompt, or null when it has no draft text. */
export function useThreadDraftPreviewText(threadId: ScopedThreadId): string | null {
  return useComposerDraftStore((state) =>
    composerThreadDraftPreviewText(state.draftsByThreadId[threadId]),
  );
}

/**
 * Threads whose composer holds an unsent message. The set only changes identity when
 * a thread gains or loses its draft, not on every keystroke.
 */
export function useThreadIdsWithPendingDraft(): ReadonlySet<ScopedThreadId> {
  const threadIds = useComposerDraftStore(useShallow(selectThreadIdsWithPendingDraft));
  return useMemo(() => new Set(threadIds), [threadIds]);
}

export function useEffectiveComposerModelState(input: {
  threadId: ScopedThreadId;
  selectedProvider: ProviderKind;
  selectedProviderInstanceId?: ProviderInstanceId | null | undefined;
  threadModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
  customModelsByProvider: Record<ProviderKind, readonly string[]>;
  availableModelOptionsByProvider?: Partial<
    Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>
  >;
}): EffectiveComposerModelState {
  const draft = useComposerThreadDraft(input.threadId);
  return deriveEffectiveComposerModelState({
    draft,
    selectedProvider: input.selectedProvider,
    selectedProviderInstanceId: input.selectedProviderInstanceId,
    threadModelSelection: input.threadModelSelection,
    projectModelSelection: input.projectModelSelection,
    customModelsByProvider: input.customModelsByProvider,
    ...(input.availableModelOptionsByProvider !== undefined
      ? { availableModelOptionsByProvider: input.availableModelOptionsByProvider }
      : {}),
  });
}

// Mark drafts as promoted first; route/composer cleanup happens after the server thread starts.
export function markPromotedDraftThreads(
  hostId: HostId,
  serverThreadIds: ReadonlySet<ThreadId>,
): void {
  const store = useComposerDraftStore.getState();
  const draftThreadIds = Object.keys(store.draftThreadsByThreadId) as ScopedThreadId[];
  for (const draftId of draftThreadIds) {
    const draft = unscopeThread(draftId);
    if (draft.hostId === hostId && serverThreadIds.has(draft.threadId)) {
      store.markDraftThreadPromoting(draftId);
    }
  }
}

export function finalizePromotedDraftThreads(
  hostId: HostId,
  serverThreadIds: ReadonlySet<ThreadId>,
): void {
  const store = useComposerDraftStore.getState();
  for (const threadId of serverThreadIds) {
    store.finalizePromotedDraftThread(scopeThread(hostId, threadId));
  }
}
