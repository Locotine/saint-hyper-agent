import type { TerminalEvent } from "@saint/contracts";
import { LOCAL_HOST_ID, type HostId } from "@saint/shared/hostId";

import { apiFor } from "~/hosts/hostApi";
import { readLocalNativeApi } from "~/nativeApi";

type TerminalEventListener = (event: TerminalEvent) => void;

function terminalEventKey(hostId: HostId, threadId: string, terminalId: string): string {
  return `${hostId}::${threadId}::${terminalId}`;
}

/** One shared terminal event listener per machine; a host's terminals stream from that host. */
class TerminalEventDispatcher {
  private listenersByKey = new Map<string, Set<TerminalEventListener>>();
  private unsubscribeByHost = new Map<HostId, () => void>();

  subscribe(
    hostId: HostId,
    threadId: string,
    terminalId: string,
    listener: TerminalEventListener,
  ): () => void {
    const key = terminalEventKey(hostId, threadId, terminalId);
    const listeners = this.listenersByKey.get(key) ?? new Set<TerminalEventListener>();
    listeners.add(listener);
    this.listenersByKey.set(key, listeners);
    this.ensureSharedListener(hostId);

    return () => {
      const nextListeners = this.listenersByKey.get(key);
      if (!nextListeners) return;
      nextListeners.delete(listener);
      if (nextListeners.size === 0) {
        this.listenersByKey.delete(key);
      }
      const prefix = `${hostId}::`;
      if (![...this.listenersByKey.keys()].some((entry) => entry.startsWith(prefix))) {
        this.unsubscribeByHost.get(hostId)?.();
        this.unsubscribeByHost.delete(hostId);
      }
    };
  }

  private ensureSharedListener(hostId: HostId): void {
    if (this.unsubscribeByHost.has(hostId)) return;
    const api = hostId === LOCAL_HOST_ID ? readLocalNativeApi() : apiFor(hostId);
    if (!api) return;

    this.unsubscribeByHost.set(
      hostId,
      api.terminal.onEvent((event) => {
        const listeners = this.listenersByKey.get(
          terminalEventKey(hostId, event.threadId, event.terminalId),
        );
        if (!listeners) return;
        for (const listener of listeners) {
          listener(event);
        }
      }),
    );
  }
}

export const terminalEventDispatcher = new TerminalEventDispatcher();
