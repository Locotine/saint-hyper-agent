// FILE: remoteFolderPickerStore.ts
// Purpose: Promise-style folder picking for remote SSH host windows. The native
//          dialog can only show this computer's folders, so `dialogs.pickFolder`
//          opens RemoteFolderPickerDialog, which browses the host through the server.
// Layer: Web UI state
// Exports: useRemoteFolderPickerStore, pickRemoteFolder

import { create } from "zustand";

interface RemoteFolderPickerStore {
  /** Settles the open request; null when no picker is open. */
  resolve: ((path: string | null) => void) | null;
  settle: (path: string | null) => void;
}

export const useRemoteFolderPickerStore = create<RemoteFolderPickerStore>((set, get) => ({
  resolve: null,
  settle: (path) => {
    const resolve = get().resolve;
    set({ resolve: null });
    resolve?.(path);
  },
}));

/** Opens the picker and resolves with the chosen host path, or null when cancelled. */
export function pickRemoteFolder(): Promise<string | null> {
  // A second request replaces the first, like a native dialog that is already up.
  useRemoteFolderPickerStore.getState().settle(null);
  return new Promise((resolve) => {
    useRemoteFolderPickerStore.setState({ resolve });
  });
}
