/**
 * commandId → originating browser socket, so a browser that is not
 * subscribed to the session still gets its own command's ack (owner report,
 * 199: saving/applying an identity from a settings page not subscribed to
 * that session timed out client-side at 20s even though the daemon acked in
 * 2-4s). Additive only: `sendJsonToSessionSubscribers`'s existing fan-out to
 * subscribers is unchanged; this is a second, deduped delivery to the one
 * socket that actually sent the command, for command.ack only.
 *
 * Applies to any browser-originated message carrying a commandId that isn't
 * already tracked by a more specific mechanism (session.send/cancel go
 * through `inflightCommands`; peer-audit RPCs through `PeerAuditUnicastRouter`).
 * That covers session.identity.refresh and any other commandId-bearing
 * command routed through the generic forward-to-daemon path.
 */
export class CommandAckOriginRouter {
  private readonly origins = new Map<string, { socket: import('ws').WebSocket; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

  record(commandId: string, socket: import('ws').WebSocket, now = Date.now()): void {
    this.origins.set(commandId, { socket, expiresAt: now + this.ttlMs });
  }

  /** Consumes the route (one-shot, so a replayed ack never double-delivers); null if none or expired. */
  take(commandId: string, now = Date.now()): import('ws').WebSocket | null {
    const entry = this.origins.get(commandId);
    if (!entry) return null;
    this.origins.delete(commandId);
    return entry.expiresAt >= now ? entry.socket : null;
  }

  dropSocket(socket: import('ws').WebSocket): void {
    for (const [commandId, entry] of this.origins) {
      if (entry.socket === socket) this.origins.delete(commandId);
    }
  }

  sweep(now = Date.now()): void {
    for (const [commandId, entry] of this.origins) {
      if (entry.expiresAt < now) this.origins.delete(commandId);
    }
  }

  size(): number {
    return this.origins.size;
  }
}
