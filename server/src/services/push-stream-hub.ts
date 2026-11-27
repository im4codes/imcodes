/**
 * In-memory SSE push stream hub for mobile clients without third-party push SDKs
 * (such as the Android withoutFcm distribution). Self-hosted servers also publish
 * directly to connected subscribers on the same instance.
 */

export const MAX_PUSH_STREAMS_PER_USER = 5;
export const PUSH_STREAM_KEEPALIVE_MS = 30_000;
export const PUSH_STREAM_MAX_BUFFERED_CHUNKS = 16;

export interface PushStreamEvent {
  id: string;
  title: string;
  body: string;
  type?: string;
  badge?: number;
  data?: Record<string, string>;
}

export interface PushStreamCredential {
  kind: 'api_key';
  keyId: string;
}

export interface PushStreamSubscription {
  send: (sseFrame: string) => boolean;
  close: () => void;
  credential?: PushStreamCredential;
}

function sanitizeSseId(id: string): string {
  return id.replace(/[\r\n\0]+/g, ' ').trim() || String(Date.now());
}

export function formatPushSseEvent(event: PushStreamEvent): string {
  const safeId = sanitizeSseId(event.id);
  const json = JSON.stringify({
    id: safeId,
    title: event.title,
    body: event.body,
    ...(event.type ? { type: event.type } : {}),
    ...(event.badge != null ? { badge: event.badge } : {}),
    ...(event.data ? { data: event.data } : {}),
  });
  return `id: ${safeId}\nevent: push\ndata: ${json}\n\n`;
}

export class PushStreamHub {
  private readonly subscribers = new Map<string, Set<PushStreamSubscription>>();

  subscribe(userId: string, sub: PushStreamSubscription): () => void {
    let userSubs = this.subscribers.get(userId);
    if (!userSubs) {
      userSubs = new Set();
      this.subscribers.set(userId, userSubs);
    }

    while (userSubs.size >= MAX_PUSH_STREAMS_PER_USER) {
      const oldest = userSubs.values().next().value as PushStreamSubscription | undefined;
      if (!oldest) break;
      userSubs.delete(oldest);
      try {
        oldest.close();
      } catch {
        // ignore errors during forced eviction
      }
    }

    userSubs.add(sub);

    return () => {
      const current = this.subscribers.get(userId);
      if (!current) return;
      current.delete(sub);
      if (current.size === 0) {
        this.subscribers.delete(userId);
      }
    };
  }

  hasSubscribers(userId: string): boolean {
    const subs = this.subscribers.get(userId);
    return !!subs && subs.size > 0;
  }

  subscriberCount(userId: string): number {
    return this.subscribers.get(userId)?.size ?? 0;
  }

  publish(userId: string, event: PushStreamEvent): number {
    const subs = this.subscribers.get(userId);
    if (!subs || subs.size === 0) return 0;

    const frame = formatPushSseEvent(event);
    let delivered = 0;
    for (const sub of [...subs]) {
      let ok = false;
      try {
        ok = sub.send(frame);
      } catch {
        ok = false;
      }
      if (ok) {
        delivered += 1;
      } else {
        subs.delete(sub);
        try {
          sub.close();
        } catch {
          // ignore
        }
      }
    }
    if (subs.size === 0) {
      this.subscribers.delete(userId);
    }
    return delivered;
  }

  collectLiveUserIds(out: Set<string>): void {
    for (const [userId, subs] of this.subscribers) {
      if (subs.size > 0) out.add(userId);
    }
  }

  collectLiveCredentials(): Array<{ userId: string; credential: PushStreamCredential }> {
    const out: Array<{ userId: string; credential: PushStreamCredential }> = [];
    for (const [userId, subs] of this.subscribers) {
      for (const sub of subs) {
        if (sub.credential) out.push({ userId, credential: sub.credential });
      }
    }
    return out;
  }

  closeMatchingSubscriptions(predicate: (userId: string, sub: PushStreamSubscription) => boolean): number {
    let closed = 0;
    for (const [userId, subs] of [...this.subscribers]) {
      for (const sub of [...subs]) {
        if (!predicate(userId, sub)) continue;
        subs.delete(sub);
        closed += 1;
        try {
          sub.close();
        } catch {
          // ignore
        }
      }
      if (subs.size === 0) {
        this.subscribers.delete(userId);
      }
    }
    return closed;
  }

  closeByApiKey(userId: string, keyId: string): number {
    if (!keyId) return 0;
    return this.closeMatchingSubscriptions(
      (uid, sub) => (!userId || uid === userId) && sub.credential?.keyId === keyId,
    );
  }

  closeByAllUserApiKeys(userId: string): number {
    if (!userId) return 0;
    return this.closeMatchingSubscriptions(
      (uid, sub) => uid === userId && sub.credential?.kind === 'api_key',
    );
  }

  closeInactiveUsers(inactiveUserIds: ReadonlySet<string>): number {
    let closed = 0;
    for (const userId of inactiveUserIds) {
      const subs = this.subscribers.get(userId);
      if (!subs) continue;
      this.subscribers.delete(userId);
      for (const sub of [...subs]) {
        closed += 1;
        try {
          sub.close();
        } catch {
          // ignore
        }
      }
    }
    return closed;
  }

  stop(): void {
    for (const subs of this.subscribers.values()) {
      for (const sub of [...subs]) {
        try {
          sub.close();
        } catch {
          // ignore
        }
      }
    }
    this.subscribers.clear();
  }
}

export const pushStreamHub = new PushStreamHub();
