// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { toBrowserIceServers } from '../src/direct-file-transfer.js';

describe('browser direct transfer ICE adapter', () => {
  it('preserves temporary TURN credentials and legacy STUN URLs', () => {
    expect(toBrowserIceServers([
      'stun:stun.cloudflare.com:3478',
      {
        urls: ['turn:im.example.com:3479?transport=udp'],
        username: '1780003600:subject',
        credential: 'temporary-password',
      },
    ])).toEqual([
      { urls: 'stun:stun.cloudflare.com:3478' },
      {
        urls: ['turn:im.example.com:3479?transport=udp'],
        username: '1780003600:subject',
        credential: 'temporary-password',
      },
    ]);
  });
});
