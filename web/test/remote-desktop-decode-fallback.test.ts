import { describe, expect, it } from 'vitest';
import {
  DecodeTimeMonitor,
  REMOTE_DESKTOP_DECODE_FALLBACK as FALLBACK,
  isRawVideoCodecMime,
  markPreferH264,
  shouldPreferH264,
  type DecodeFallbackStore,
} from '../src/remote-desktop-decode-fallback.js';
import { prioritizeH264ReceiveCodecs } from '../src/remote-desktop-client.js';

function memoryStore(initial: string | null = null): DecodeFallbackStore & { value: string | null } {
  const store = {
    value: initial,
    get: () => store.value,
    set: (v: string) => { store.value = v; },
    remove: () => { store.value = null; },
  };
  return store;
}

// A decoder spending `ms` per frame, `framesPerSecond` frames each second.
function feed(monitor: DecodeTimeMonitor, seconds: number, ms: number, opts: {
  mime?: string; visible?: boolean; framesPerSecond?: number; start?: { frames: number; time: number };
} = {}): { verdicts: Array<'slow' | null>; frames: number; time: number } {
  let frames = opts.start?.frames ?? 0;
  let time = opts.start?.time ?? 0;
  const fps = opts.framesPerSecond ?? 10;
  const verdicts: Array<'slow' | null> = [];
  for (let i = 0; i < seconds; i += 1) {
    frames += fps;
    time += (fps * ms) / 1_000;
    verdicts.push(monitor.observe({
      visible: opts.visible ?? true,
      mimeType: opts.mime ?? 'video/VP9',
      framesDecoded: frames,
      totalDecodeTimeSeconds: time,
    }));
  }
  return { verdicts, frames, time };
}

describe('remote desktop VP9 decode-time fallback', () => {
  it('flags VP9 that stays slow to decode, once, after the sustained run', () => {
    const monitor = new DecodeTimeMonitor();
    const { verdicts } = feed(monitor, 30, 60);
    // The first sample only primes the baseline; the 10th slow sample is the 11th call.
    expect(verdicts.indexOf('slow')).toBe(FALLBACK.SUSTAINED_SAMPLES);
    expect(verdicts.filter((v) => v === 'slow')).toHaveLength(1);
  });

  it('leaves a fast decoder alone, however long it runs', () => {
    const monitor = new DecodeTimeMonitor();
    expect(feed(monitor, 120, 12).verdicts.every((v) => v === null)).toBe(true);
    // Just under the threshold is fast.
    expect(feed(new DecodeTimeMonitor(), 60, FALLBACK.SLOW_DECODE_MS - 1).verdicts.every((v) => v === null)).toBe(true);
  });

  it('needs the slowness to be sustained: one good second resets the run', () => {
    const monitor = new DecodeTimeMonitor();
    let state = feed(monitor, 9, 80);
    state = feed(monitor, 1, 10, { start: state });
    state = feed(monitor, 9, 80, { start: state });
    expect(state.verdicts.every((v) => v === null)).toBe(true);
    expect(feed(monitor, 3, 80, { start: state }).verdicts).toContain('slow');
  });

  it('ignores H.264, a hidden tab, and a browser that reports no decode statistics', () => {
    expect(feed(new DecodeTimeMonitor(), 40, 200, { mime: 'video/H264' }).verdicts.every((v) => v === null)).toBe(true);
    expect(feed(new DecodeTimeMonitor(), 40, 200, { visible: false }).verdicts.every((v) => v === null)).toBe(true);
    const monitor = new DecodeTimeMonitor();
    for (let i = 0; i < 40; i += 1) {
      expect(monitor.observe({ visible: true, mimeType: 'video/VP9', framesDecoded: undefined, totalDecodeTimeSeconds: undefined })).toBeNull();
    }
    // Codec unknown (no codec stats entry): conservative, never a verdict.
    expect(feed(new DecodeTimeMonitor(), 40, 200, { mime: '' }).verdicts.every((v) => v === null)).toBe(true);
  });

  it('a still screen neither confirms nor clears the verdict', () => {
    const monitor = new DecodeTimeMonitor();
    let state = feed(monitor, 6, 80);
    // 1 keep-alive frame per second: below the per-sample minimum, so the streak is kept.
    state = feed(monitor, 5, 80, { start: state, framesPerSecond: 1 });
    expect(state.verdicts.every((v) => v === null)).toBe(true);
    expect(feed(monitor, 6, 80, { start: state }).verdicts).toContain('slow');
  });

  it('survives counters that go backwards (a new stream)', () => {
    const monitor = new DecodeTimeMonitor();
    const state = feed(monitor, 8, 80);
    expect(monitor.observe({ visible: true, mimeType: 'video/VP9', framesDecoded: 5, totalDecodeTimeSeconds: 0.1 })).toBeNull();
    expect(state.verdicts.every((v) => v === null)).toBe(true);
  });

  it('remembers the preference for a bounded time and forgets a bogus value', () => {
    const store = memoryStore();
    expect(shouldPreferH264(store, 1_000)).toBe(false);
    markPreferH264(store, 1_000);
    expect(store.value).toBe(String(1_000 + FALLBACK.TTL_MS));
    expect(shouldPreferH264(store, 1_000 + FALLBACK.TTL_MS - 1)).toBe(true);
    expect(shouldPreferH264(store, 1_000 + FALLBACK.TTL_MS)).toBe(false);
    expect(store.value).toBeNull();
    expect(shouldPreferH264(memoryStore('not a number'), 5)).toBe(false);
    // Further out than one TTL did not come from us.
    expect(shouldPreferH264(memoryStore(String(10 * FALLBACK.TTL_MS)), 5)).toBe(false);
    expect(shouldPreferH264(null, 5)).toBe(false);
    expect(() => markPreferH264(null, 5)).not.toThrow();
    const broken: DecodeFallbackStore = {
      get: () => { throw new Error('blocked'); }, set: () => { throw new Error('full'); }, remove: () => { throw new Error('x'); },
    };
    expect(shouldPreferH264(broken, 5)).toBe(false);
    expect(() => markPreferH264(broken, 5)).not.toThrow();
  });

  it('drops VP8/VP9 from the offer only when asked, and keeps H.264 first with its repair payloads', () => {
    const codec = (mimeType: string, sdpFmtpLine?: string) => ({ mimeType, clockRate: 90_000, sdpFmtpLine }) as RTCRtpCodec;
    const codecs = [
      codec('video/VP8'), codec('video/rtx', 'apt=96'), codec('video/H264', 'packetization-mode=1'),
      codec('video/VP9', 'profile-id=0'), codec('video/red'), codec('video/AV1'),
    ];
    const normal = prioritizeH264ReceiveCodecs(codecs)!;
    expect(normal.map((c) => c.mimeType)).toEqual(['video/H264', 'video/VP8', 'video/rtx', 'video/VP9', 'video/red', 'video/AV1']);
    const dropped = prioritizeH264ReceiveCodecs(codecs, { dropVp8Vp9: true })!;
    expect(dropped.map((c) => c.mimeType)).toEqual(['video/H264', 'video/rtx', 'video/red', 'video/AV1']);
    // With no H.264 at all the browser defaults are left alone, even under the fallback.
    expect(prioritizeH264ReceiveCodecs([codec('video/VP9')], { dropVp8Vp9: true })).toBeNull();
    expect(isRawVideoCodecMime('video/VP9') && isRawVideoCodecMime('VIDEO/vp8')).toBe(true);
    expect(isRawVideoCodecMime('video/H264') || isRawVideoCodecMime(undefined)).toBe(false);
  });
});
