// When a Mac with no hardware H.264 encoder sends VP9 (see native/macos-remote-
// desktop/README.md), a viewer that cannot decode it fast -- software decoding of
// a 2560x1350 picture on a phone or an old laptop -- would do worse than with
// H.264, which that device decodes in hardware. This watches the browser's own
// decode time and, if VP9/VP8 stays too slow, remembers to leave VP8/VP9 out of
// this browser's next offer. The node answers from the offer, so the next
// negotiation lands on H.264. The running session is not interrupted.

export const REMOTE_DESKTOP_DECODE_FALLBACK = {
  /** localStorage key; the value is the epoch-ms until which VP8/VP9 are not offered. */
  STORAGE_KEY: 'imcodes.remoteDesktop.preferH264Until',
  /** How long the preference lasts. Long enough not to flip-flop a slow device, short
   *  enough that a transient cause (or an upgraded browser) is retried. */
  TTL_MS: 3 * 24 * 60 * 60 * 1000,
  /** Average decode time per frame at or above which VP9/VP8 counts as too slow: the
   *  decoder alone is using ~half the budget of a 10 fps picture, and cannot keep 25. */
  SLOW_DECODE_MS: 45,
  /** Consecutive one-second samples that must be slow (a still screen decodes almost
   *  nothing and neither confirms nor clears it). */
  SUSTAINED_SAMPLES: 10,
  /** A sample needs at least this many decoded frames to say anything. */
  MIN_FRAMES_PER_SAMPLE: 3,
} as const;

export interface DecodeFallbackStore {
  get(): string | null;
  set(value: string): void;
  remove(): void;
}

/** localStorage when the browser lets us use it; null otherwise (private mode, a
 *  sandboxed frame): the fallback then simply does not persist. */
export function browserDecodeFallbackStore(): DecodeFallbackStore | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const key = REMOTE_DESKTOP_DECODE_FALLBACK.STORAGE_KEY;
    return {
      get: () => localStorage.getItem(key),
      set: (value) => localStorage.setItem(key, value),
      remove: () => localStorage.removeItem(key),
    };
  } catch {
    return null;
  }
}

/** True while a previous session found VP8/VP9 too slow to decode on this browser. */
export function shouldPreferH264(store: DecodeFallbackStore | null, now: number): boolean {
  if (!store) return false;
  try {
    const raw = store.get();
    if (raw === null) return false;
    const until = Number(raw);
    if (!Number.isFinite(until) || until <= now) {
      store.remove();
      return false;
    }
    // A value further out than one TTL did not come from us; do not honour it forever.
    return until - now <= REMOTE_DESKTOP_DECODE_FALLBACK.TTL_MS;
  } catch {
    return false;
  }
}

export function markPreferH264(store: DecodeFallbackStore | null, now: number): void {
  if (!store) return;
  try {
    store.set(String(now + REMOTE_DESKTOP_DECODE_FALLBACK.TTL_MS));
  } catch {
    // Storage full or blocked: the fallback just does not persist.
  }
}

export function isRawVideoCodecMime(mimeType: string | undefined): boolean {
  const mime = (mimeType ?? '').toLowerCase();
  return mime === 'video/vp9' || mime === 'video/vp8';
}

export interface DecodeSample {
  /** Document is visible; a hidden tab's decode time says nothing about the device. */
  visible: boolean;
  /** MIME type of the codec the inbound video is using, when known. */
  mimeType: string | undefined;
  /** inbound-rtp framesDecoded / totalDecodeTime (seconds), cumulative. */
  framesDecoded: number | undefined;
  totalDecodeTimeSeconds: number | undefined;
}

/** Feeds on one stats sample per second; says 'slow' once, when VP9/VP8 has been too
 *  slow to decode for long enough. One monitor per peer connection. */
export class DecodeTimeMonitor {
  private previous: { frames: number; seconds: number } | null = null;
  private slowStreak = 0;
  private reported = false;

  observe(sample: DecodeSample): 'slow' | null {
    const { framesDecoded: frames, totalDecodeTimeSeconds: seconds } = sample;
    if (!sample.visible || !isRawVideoCodecMime(sample.mimeType)
      || typeof frames !== 'number' || typeof seconds !== 'number'
      || !Number.isFinite(frames) || !Number.isFinite(seconds)) {
      // Hidden, H.264, or no decode statistics: nothing to judge, and nothing to carry over.
      this.previous = null;
      this.slowStreak = 0;
      return null;
    }
    const previous = this.previous;
    this.previous = { frames, seconds };
    if (!previous || frames < previous.frames || seconds < previous.seconds) {
      this.slowStreak = 0;
      return null;
    }
    const decoded = frames - previous.frames;
    if (decoded < REMOTE_DESKTOP_DECODE_FALLBACK.MIN_FRAMES_PER_SAMPLE) return null;
    const averageMs = ((seconds - previous.seconds) / decoded) * 1_000;
    this.slowStreak = averageMs >= REMOTE_DESKTOP_DECODE_FALLBACK.SLOW_DECODE_MS
      ? this.slowStreak + 1
      : 0;
    if (this.reported || this.slowStreak < REMOTE_DESKTOP_DECODE_FALLBACK.SUSTAINED_SAMPLES) {
      return null;
    }
    this.reported = true;
    return 'slow';
  }
}
