import type WebSocket from 'ws';
import type { Database } from '../db/client.js';
import { resolveControlledMachineReadActors } from '../share/machine-access.js';
import { SHARE_MESSAGE_LANE_MAX_PENDING } from './share-lanes.js';

const READ_AUTHORITY_TIMEOUT_MS = 2_000;

/** Ordered, live authorization for controlled-node metadata only. FULL sockets never enter this lane. */
export class ControlledBrowserReadGate {
  private readonly actors = new Map<WebSocket, string>();
  private lane: Promise<void> = Promise.resolve();
  private pending = 0;
  private epoch = 0;

  constructor(private readonly serverId: string, private readonly database: () => Database | null,
    private readonly invalidate: (socket: WebSocket) => void) {}

  register(socket: WebSocket, actor: string): void { this.actors.set(socket, actor); }
  remove(socket: WebSocket): void { this.actors.delete(socket); }
  send(socket: WebSocket, json: string): void {
    const actor = this.actors.get(socket);
    if (actor !== undefined) void this.enqueue([[socket, actor]], json);
  }
  broadcast(json: string): void { void this.enqueue([...this.actors], json); }
  revalidate(actor?: string): Promise<void> {
    // Fence an in-flight read before waiting on its queue: its old SQL snapshot cannot serve a revoke.
    this.epoch++;
    return this.enqueue([...this.actors].filter(([, user]) => actor === undefined || user === actor));
  }

  private enqueue(targets: Array<[WebSocket, string]>, json?: string): Promise<void> {
    if (!targets.length) return Promise.resolve();
    if (this.pending >= SHARE_MESSAGE_LANE_MAX_PENDING) {
      for (const socket of [...this.actors.keys()]) this.invalidate(socket);
      return Promise.resolve();
    }
    this.pending++;
    const operation = this.lane.then(async () => {
      const current = targets.filter(([socket, actor]) => this.actors.has(socket) && this.actors.get(socket) === actor);
      if (!current.length) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const db = this.database();
        if (!db) throw new Error('controlled_read_authority_unavailable');
        const users = [...new Set(current.map(([, actor]) => actor))];
        const deadline = Date.now() + READ_AUTHORITY_TIMEOUT_MS;
        let allowed: Set<string> | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          const epoch = this.epoch;
          allowed = await Promise.race([
            resolveControlledMachineReadActors(db, this.serverId, users, Date.now()),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('controlled_read_authority_timeout')), Math.max(1, deadline - Date.now())); timer.unref?.(); }),
          ]);
          if (timer) clearTimeout(timer);
          if (epoch === this.epoch) break;
          allowed = undefined;
        }
        if (!allowed) throw new Error('controlled_read_authority_changed');
        for (const [socket, actor] of current) {
          if (!this.actors.has(socket) || this.actors.get(socket) !== actor) continue;
          if (!allowed.has(actor)) { this.invalidate(socket); continue; }
          if (json !== undefined && socket.readyState === 1) {
            try { socket.send(json); } catch { this.invalidate(socket); }
          }
        }
      } catch {
        // Unavailable node authority affects this node's entire read lane. Close
        // them together within the timeout, not one two-second query per socket.
        for (const socket of [...this.actors.keys()]) this.invalidate(socket);
      } finally { if (timer) clearTimeout(timer); }
    }).finally(() => { this.pending--; });
    this.lane = operation.catch(() => {});
    return this.lane;
  }
}
