import type { NativeApi, TerminalEvent } from "@saint/contracts";
import { LOCAL_HOST_ID, type HostId } from "@saint/shared/hostId";

import { apiFor } from "~/hosts/hostApi";
import { hostConnections } from "~/hosts/hostConnectionRegistry";
import { readLocalNativeApi } from "~/nativeApi";

type TerminalEventListener = (event: TerminalEvent) => void;

function terminalEventKey(hostId: HostId, threadId: string, terminalId: string): string {
  return `${hostId}::${threadId}::${terminalId}`;
}

/** One shared terminal event listener per machine; a host's terminals stream from that host. */
class TerminalEventDispatcher {
  private listenersByKey = new Map<string, Set<TerminalEventListener>>();
  private unsubscribeByHost = new Map<HostId, () => void>();
  private subscribedApiByHost = new Map<HostId, NativeApi>();
  private unsubscribeHostConnections: (() => void) | null = null;

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
    if (hostId !== LOCAL_HOST_ID) {
      this.ensureHostConnectionsSubscription();
    }
    this.ensureSharedListener(hostId);

    return () => {
      const nextListeners = this.listenersByKey.get(key);
      if (!nextListeners) return;
      nextListeners.delete(listener);
      if (nextListeners.size === 0) {
        this.listenersByKey.delete(key);
      }
      if (!this.hasListenersForHost(hostId)) {
        this.teardownHostListener(hostId);
      }
      if (!this.hasAnyRemoteHostListeners()) {
        this.unsubscribeHostConnections?.();
        this.unsubscribeHostConnections = null;
      }
    };
  }

  private hasListenersForHost(hostId: HostId): boolean {
    const prefix = `${hostId}::`;
    for (const key of this.listenersByKey.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  private hasAnyRemoteHostListeners(): boolean {
    const localPrefix = `${LOCAL_HOST_ID}::`;
    for (const key of this.listenersByKey.keys()) {
      if (!key.startsWith(localPrefix)) return true;
    }
    return false;
  }

  private ensureHostConnectionsSubscription(): void {
    if (this.unsubscribeHostConnections) return;
    this.unsubscribeHostConnections = hostConnections.subscribe(() => {
      this.reconcileRemoteHostListeners();
    });
  }

  private reconcileRemoteHostListeners(): void {
    const remoteHostIds = new Set<HostId>();
    const localPrefix = `${LOCAL_HOST_ID}::`;
    for (const key of this.listenersByKey.keys()) {
      if (key.startsWith(localPrefix)) continue;
      const separatorIndex = key.indexOf("::");
      if (separatorIndex > 0) {
        remoteHostIds.add(key.slice(0, separatorIndex) as HostId);
      }
    }
    for (const hostId of remoteHostIds) {
      this.ensureSharedListener(hostId);
    }
  }

  private teardownHostListener(hostId: HostId): void {
    this.unsubscribeByHost.get(hostId)?.();
    this.unsubscribeByHost.delete(hostId);
    this.subscribedApiByHost.delete(hostId);
  }

  private ensureSharedListener(hostId: HostId): void {
    const api = hostId === LOCAL_HOST_ID ? readLocalNativeApi() : apiFor(hostId);
    const currentApi = this.subscribedApiByHost.get(hostId);
    if (currentApi === api && this.unsubscribeByHost.has(hostId)) {
      return;
    }
    this.teardownHostListener(hostId);
    if (!api) return;

    this.subscribedApiByHost.set(hostId, api);
    this.unsubscribeByHost.set(
      hostId,
      api.terminal.onEvent((event) => {
        const listeners = this.listenersByKey.get(
          terminalEventKey(hostId, event.threadId, event.terminalId),
        );
        if (!listeners) return;
        for (const listener of [...listeners]) {
          listener(event);
        }
      }),
    );
  }
}

export const terminalEventDispatcher = new TerminalEventDispatcher();
