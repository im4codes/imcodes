export const SHARE_SEND_PENDING_LIMIT = 10;
export const SHARE_SEND_ATTEMPT_LIMIT = 30;
export const SHARE_CANCEL_ATTEMPT_LIMIT = 10;
export const SHARE_RATE_LIMIT_WINDOW_MS = 60_000;

type ShareCommandType = 'session.send' | 'session.cancel';
type ShareRateLimitReason = 'share-rate-limited';

interface ShareRateBucket {
  windowStart: number;
  count: number;
}

const shareSendAttemptBuckets = new Map<string, ShareRateBucket>();
const shareCancelAttemptBuckets = new Map<string, ShareRateBucket>();

export function evaluateSharedCommandRateLimit(params: {
  userId: string;
  serverId: string;
  sessionName: string;
  commandType: ShareCommandType;
  now: number;
  pendingSendCount?: number;
}): ShareRateLimitReason | null {
  const key = `${params.userId}:${params.serverId}:${params.sessionName}`;
  if (params.commandType === 'session.send') {
    if ((params.pendingSendCount ?? 0) >= SHARE_SEND_PENDING_LIMIT) return 'share-rate-limited';
    return consumeShareRateBucket(shareSendAttemptBuckets, key, SHARE_SEND_ATTEMPT_LIMIT, params.now)
      ? null
      : 'share-rate-limited';
  }
  return consumeShareRateBucket(shareCancelAttemptBuckets, key, SHARE_CANCEL_ATTEMPT_LIMIT, params.now)
    ? null
    : 'share-rate-limited';
}

export function resetSharedCommandRateLimitsForTests(): void {
  shareSendAttemptBuckets.clear();
  shareCancelAttemptBuckets.clear();
}

function consumeShareRateBucket(
  buckets: Map<string, ShareRateBucket>,
  key: string,
  limit: number,
  now: number,
): boolean {
  const current = buckets.get(key);
  if (!current || now - current.windowStart >= SHARE_RATE_LIMIT_WINDOW_MS) {
    buckets.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}
