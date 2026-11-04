import type { ThreadId } from "@saint/contracts";
import { useEffect } from "react";

import { LOCAL_HOST_ID } from "@saint/shared/hostId";
import { useHostId } from "~/hosts/hostScope";
import { ensureLocalNativeApi } from "~/nativeApi";
import { addWsTransportStateListener } from "~/wsTransportEvents";
import { useComputerStateStore } from "../computerStateStore";

// Push events never carry a full snapshot, so every surface that renders
// computer availability (the ambient preview and the composer's computer-control
// toggle) seeds the store with one getThreadState on mount and re-seeds on
// transport reopen.
export function useThreadComputerStateSeed(threadId: ThreadId): void {
  const upsertThreadState = useComputerStateStore((store) => store.upsertThreadState);
  const hostId = useHostId();

  useEffect(() => {
    // Computer control drives this computer; a connected host's thread is not known here.
    if (hostId !== LOCAL_HOST_ID) {
      return;
    }
    // Desktop-bridge NativeApi implementations update out of band and may
    // predate the computer namespace.
    if (!ensureLocalNativeApi().computer) {
      return;
    }
    let cancelled = false;
    const seed = () => {
      void ensureLocalNativeApi()
        .computer.getThreadState({ threadId })
        .then((state) => {
          if (!cancelled) upsertThreadState(state);
        })
        .catch(() => {
          // The state push or the next transport-open seed can still provide a
          // usable availability result after a transient RPC failure.
        });
    };
    seed();
    const unsubscribe = addWsTransportStateListener((state) => {
      if (state === "open") seed();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [hostId, threadId, upsertThreadState]);
}
