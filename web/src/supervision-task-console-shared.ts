import type { SupervisionTaskConsoleScope } from '@shared/supervision-task-console.js';
import {
  SupervisionTaskConsoleController,
  type SupervisionTaskConsoleSocket,
} from './supervision-task-console-controller.js';
import type { SupervisionTaskConsoleAuthority } from './supervision-task-console-cache.js';

/**
 * One controller per (socket, authority), shared by every view of that scope.
 *
 * The compact chat panel's bridge and the full console both view the same
 * scope. Each used to own a controller, i.e. its own subscription, and the
 * daemon keeps one subscription per page and scope: the newer one superseded
 * the older, whose frames were then dropped as stale forever, and closing the
 * console unsubscribed the scope outright - leaving the panel frozen on
 * whatever it last showed. Sharing the controller gives the page exactly one
 * subscription however many views are open; it lives while any view holds a
 * lease and is released (unsubscribed) when the last one lets go.
 */

interface SharedEntry {
  controller: SupervisionTaskConsoleController;
  /** Connected flag per lease; the controller is connected while any lease says so. */
  leases: Map<symbol, boolean>;
}

const sharedByOwner = new WeakMap<object, Map<string, SharedEntry>>();

function authorityKey(authority: SupervisionTaskConsoleAuthority): string {
  return JSON.stringify([authority.userId, authority.serverId, authority.projectName, authority.coordinatorSessionName]);
}

export interface SupervisionTaskConsoleLease {
  readonly controller: SupervisionTaskConsoleController;
  setConnected(connected: boolean): void;
  release(): void;
}

/** The live shared controller for this socket + authority, if a view holds one. */
export function peekSharedSupervisionTaskConsoleController(
  owner: object,
  authority: SupervisionTaskConsoleAuthority,
): SupervisionTaskConsoleController | undefined {
  return sharedByOwner.get(owner)?.get(authorityKey(authority))?.controller;
}

/**
 * `owner` identifies the socket (the WsClient): a replaced socket gets fresh
 * controllers, the old ones die with their last lease.
 */
export function leaseSupervisionTaskConsoleController(
  owner: object,
  socket: SupervisionTaskConsoleSocket,
  scope: SupervisionTaskConsoleScope,
  authority: SupervisionTaskConsoleAuthority,
): SupervisionTaskConsoleLease {
  let entries = sharedByOwner.get(owner);
  if (!entries) { entries = new Map(); sharedByOwner.set(owner, entries); }
  const key = authorityKey(authority);
  let entry = entries.get(key);
  if (!entry) {
    entry = { controller: new SupervisionTaskConsoleController(socket, scope, authority), leases: new Map() };
    entries.set(key, entry);
    entry.controller.start();
  }
  const shared = entry;
  const id = Symbol('lease');
  shared.leases.set(id, false);
  let released = false;
  const apply = () => shared.controller.setConnected([...shared.leases.values()].some(Boolean));
  return {
    controller: shared.controller,
    setConnected(connected) {
      if (released) return;
      shared.leases.set(id, connected);
      apply();
    },
    release() {
      if (released) return;
      released = true;
      shared.leases.delete(id);
      if (shared.leases.size > 0) { apply(); return; }
      shared.controller.stop();
      const current = sharedByOwner.get(owner);
      if (current?.get(key) === shared) current.delete(key);
    },
  };
}
