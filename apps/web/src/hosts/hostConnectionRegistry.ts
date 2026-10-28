// FILE: hostConnectionRegistry.ts
// Purpose: One WsTransport per host and connection epoch, shared by everything that reads that
//          host (catalog today; store pump and API in later phases). Reference counted, so an
//          unused host holds no socket and the server can idle-exit.
// Layer: Web host connections
// Exports: createHostConnectionRegistry, hostConnections, HostConnectionLease

import type { HostId } from "@saint/shared/hostId";

import { WsTransport } from "../wsTransport";

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
  create: (url: string) => T,
) {
  const current = new Map<HostId, Entry<T>>();

  return {
    /**
     * Same host and epoch share one transport. A new epoch (new token) gets a fresh
     * transport; holders of the old one keep it until they release it.
     */
    acquire(hostId: HostId, epoch: number, url: string): HostConnectionLease<T> {
      let entry = current.get(hostId);
      if (!entry || entry.epoch !== epoch) {
        entry = { epoch, transport: create(url), refs: 0 };
        current.set(hostId, entry);
      }
      entry.refs += 1;
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
          if (current.get(hostId) === held) current.delete(hostId);
          dispose(held);
        },
      };
    },
    /** Hosts that currently hold a transport. */
    size: () => current.size,
  };
}

export const hostConnections = createHostConnectionRegistry((url) => new WsTransport(url));
