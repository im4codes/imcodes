import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  REMOTE_DESKTOP_CAPABILITY,
} from '../../shared/remote-desktop.js';
import {
  CONTROLLED_NODE_CAPABILITY_MAX_ITEMS,
  CONTROLLED_NODE_CAPABILITY_MAX_LENGTH,
  parseAdvertisedControlledNodeCapabilities,
  validateControlledNodeCapabilities,
} from '../../shared/controlled-node-capabilities.js';
import {
  PendingWebRtcCandidates,
  readWebRtcCandidateType,
  toWebRtcIceServers,
} from '../../shared/webrtc-connectivity.js';

describe('shared WebRTC connectivity primitives', () => {
  it('converts structured STUN/TURN authority without dropping credentials', () => {
    expect(toWebRtcIceServers([
      'stun:stun.example.test:3478',
      {
        urls: ['turn:turn.example.test:3478?transport=udp', 'turn:turn.example.test:3478?transport=tcp'],
        username: 'bounded-user',
        credential: 'bounded-secret',
      },
    ])).toEqual([
      { urls: 'stun:stun.example.test:3478' },
      {
        urls: ['turn:turn.example.test:3478?transport=udp', 'turn:turn.example.test:3478?transport=tcp'],
        username: 'bounded-user',
        credential: 'bounded-secret',
      },
    ]);
  });

  it('classifies only standardized candidate types', () => {
    expect(readWebRtcCandidateType('candidate:1 1 udp 1 10.0.0.1 5000 typ host')).toBe('host');
    expect(readWebRtcCandidateType('redacted', 'relay')).toBe('relay');
    expect(readWebRtcCandidateType('candidate:1 1 udp 1 10.0.0.1 5000 typ invented')).toBeNull();
  });

  it('flushes pre-description ICE in arrival order exactly once', async () => {
    const pending = new PendingWebRtcCandidates<number>();
    pending.push(2);
    pending.push(1);
    const seen: number[] = [];
    await pending.flush(async (candidate) => { seen.push(candidate); });
    await pending.flush(async (candidate) => { seen.push(candidate); });
    expect(seen).toEqual([2, 1]);
    expect(pending.size).toBe(0);
  });
});

describe('controlled-node capability version boundary', () => {
  it('accepts absence and exact known versions but rejects unknown versions', () => {
    expect(validateControlledNodeCapabilities(undefined)).toEqual({ ok: true, value: [] });
    expect(validateControlledNodeCapabilities([REMOTE_DESKTOP_CAPABILITY, REMOTE_DESKTOP_CAPABILITY]))
      .toEqual({ ok: true, value: [REMOTE_DESKTOP_CAPABILITY] });
    expect(validateControlledNodeCapabilities(['remote.desktop.windows.h264.v3'])).toEqual({ ok: false });
    expect(validateControlledNodeCapabilities(['unknown.feature.v1'])).toEqual({ ok: false });
  });

  it('ignores bounded future advertisements without granting them', () => {
    expect(parseAdvertisedControlledNodeCapabilities([
      REMOTE_DESKTOP_CAPABILITY,
      'remote.desktop.windows.h264.v3',
      'unknown.feature.v1',
    ])).toEqual({ ok: true, value: [REMOTE_DESKTOP_CAPABILITY] });
  });

  it('rejects malformed or unbounded capability advertisements', () => {
    expect(parseAdvertisedControlledNodeCapabilities(['remote desktop v3'])).toEqual({ ok: false });
    expect(parseAdvertisedControlledNodeCapabilities([1])).toEqual({ ok: false });
    expect(parseAdvertisedControlledNodeCapabilities([
      `a${'b'.repeat(CONTROLLED_NODE_CAPABILITY_MAX_LENGTH)}`,
    ])).toEqual({ ok: false });
    expect(parseAdvertisedControlledNodeCapabilities(
      Array.from({ length: CONTROLLED_NODE_CAPABILITY_MAX_ITEMS + 1 }, () => 'future.feature.v1'),
    )).toEqual({ ok: false });
  });
});

describe('remote desktop shared import boundary', () => {
  it('does not import browser, Server, daemon, worker, secret, or deployment modules', async () => {
    const source = await readFile(new URL('../../shared/remote-desktop.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
    expect(imports).toEqual(['./direct-file-transfer.js']);
    expect(source).not.toMatch(/process\.env|node:|server\/|web\/|src\/node|native\/|credentialSecret/i);
  });
});
