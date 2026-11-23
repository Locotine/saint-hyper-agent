// FILE: hostConnectionRegistry.ts
// Purpose: One WsTransport per host and connection epoch, shared by everything that reads that
//          host (catalog today; store pump and API in later phases). Reference counted, so an
//          unused host holds no socket and the server can idle-exit.
// Layer: Web host connections
// Exports: createHostConnectionRegistry, hostConnections, HostConnectionLease

import type { HostId } from "@saint/shared/hostId";

import { WsTransport } from "../wsTransport";
import { emitWsTransportState } from "../wsTransportEvents";

export interface HostConnectionLease<T> {
  readonly hostId: HostId;
  readonly epoch: number;
  readonly transport: T;
  /** Idempotent. The transport is disposed when its last lease is released. */
  readonly release: () => void;
}

interface Entry<T> {
  readonly epoch: number;
  readonly transport: T;
  refs: number;
}

function dispose<T extends { dispose: () => Promise<void> | void }>(entry: Entry<T>): void {
  void Promise.resolve(entry.transport.dispose()).catch(() => undefined);
}

export function createHostConnectionRegistry<T extends { dispose: () => Promise<void> | void }>(
  create: (url: string, hostId: HostId) => T,
) {
  const current = new Map<HostId, Entry<T>>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) {
      listener();
    }
  };

  return {
    /**
     * Same host and epoch share one transport. A new epoch (new token) gets a fresh
     * transport; holders of the old one keep it until they release it.
     */
    acquire(hostId: HostId, epoch: number, url: string): HostConnectionLease<T> {
      let entry = current.get(hostId);
      let changed = false;
      if (!entry || entry.epoch !== epoch) {
        entry = { epoch, transport: create(url, hostId), refs: 0 };
        current.set(hostId, entry);
        changed = true;
      }
      entry.refs += 1;
      if (changed) notify();
      const held = entry;
      let released = false;
      return {
        hostId,
        epoch,
        transport: held.transport,
        release: () => {
          if (released) return;
          released = true;
          held.refs -= 1;
          if (held.refs > 0) return;
          if (current.get(hostId) === held) {
            current.delete(hostId);
            notify();
          }
          dispose(held);
        },
      };
    },
    /** The host's current transport while something holds it; never opens one. */
    peek: (hostId: HostId): T | undefined => current.get(hostId)?.transport,
    /** Subscribes to active host connection changes (acquire of new/replaced entry or final release). */
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Hosts that currently hold a transport. */
    size: () => current.size,
  };
}

export const hostConnections = createHostConnectionRegistry((url, hostId) => {
  const transport = new WsTransport(url, { hostId });
  transport.onStateChange((state) => emitWsTransportState(state, hostId));
  return transport;
});
