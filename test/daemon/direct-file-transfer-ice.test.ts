import { describe, expect, it } from 'vitest';
import { toNodeDataChannelIceServers } from '../../src/daemon/direct-file-transfer.js';

describe('daemon direct transfer ICE adapter', () => {
  it('maps authenticated UDP and TCP TURN entries for node-datachannel', () => {
    expect(toNodeDataChannelIceServers([
      'stun:stun.cloudflare.com:3478',
      {
        urls: [
          'turn:im.example.com:3479?transport=udp',
          'turn:im.example.com:3479?transport=tcp',
        ],
        username: '1780003600:subject',
        credential: 'temporary-password',
      },
    ])).toEqual([
      'stun:stun.cloudflare.com:3478',
      {
        hostname: 'im.example.com',
        port: 3479,
        username: '1780003600:subject',
        password: 'temporary-password',
        relayType: 'TurnUdp',
      },
      {
        hostname: 'im.example.com',
        port: 3479,
        username: '1780003600:subject',
        password: 'temporary-password',
        relayType: 'TurnTcp',
      },
    ]);
  });

  it('rejects malformed TURN adapter input instead of creating a peer', () => {
    expect(() => toNodeDataChannelIceServers([{
      urls: ['turn:im.example.com:99999?transport=udp'],
      username: 'user',
      credential: 'password',
    }])).toThrow('Invalid TURN server port');
  });
});
