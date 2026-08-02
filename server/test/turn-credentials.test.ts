import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createTurnIceServerAuthority,
  createTurnIceServers,
  readTurnServiceConfig,
} from '../src/ws/turn-credentials.js';

const env = {
  TURN_ENABLED: 'true',
  TURN_HOST: 'im.example.com',
  TURN_PORT: '3479',
  TURN_EXTERNAL_IP: '203.0.113.10',
  TURN_SHARED_SECRET: 'a'.repeat(64),
  TURN_CREDENTIAL_TTL_SECONDS: '3600',
  TURN_RELAY_MIN_PORT: '49160',
  TURN_RELAY_MAX_PORT: '49200',
};

describe('temporary TURN credentials', () => {
  it('mints coturn REST credentials bound to user and expiry without exposing the shared secret', () => {
    const nowMs = 1_780_000_000_000;
    const servers = createTurnIceServers('user-a', { env, nowMs });
    expect(servers).toHaveLength(3);
    const turn = servers[1];
    expect(typeof turn).toBe('object');
    if (typeof turn === 'string') throw new Error('expected structured TURN entry');
    const subject = createHash('sha256').update('user-a').digest('hex').slice(0, 24);
    const username = `${Math.floor(nowMs / 1000) + 3600}:${subject}`;
    const credential = createHmac('sha1', env.TURN_SHARED_SECRET).update(username).digest('base64');
    expect(turn).toEqual({
      urls: ['turn:im.example.com:3479?transport=udp'],
      username,
      credential,
    });
    expect(JSON.stringify(servers)).not.toContain(env.TURN_SHARED_SECRET);
    expect(createTurnIceServers('user-b', { env, nowMs })[1]).not.toEqual(turn);
    expect(createTurnIceServerAuthority('user-a', { env, nowMs })).toMatchObject({
      credentialExpiresAt: nowMs + 3_600_000,
      iceServers: servers,
    });
  });

  it('defaults temporary credentials beyond the sliding two-hour route window', () => {
    const nowMs = 1_780_000_000_000;
    const authority = createTurnIceServerAuthority('user-a', {
      env: { ...env, TURN_CREDENTIAL_TTL_SECONDS: undefined },
      nowMs,
    });
    expect(authority.credentialExpiresAt).toBe(nowMs + 24 * 60 * 60 * 1000);
  });

  it('fails closed to STUN for incomplete or out-of-bounds configuration', () => {
    expect(readTurnServiceConfig({ ...env, TURN_SHARED_SECRET: 'short' })).toBeUndefined();
    expect(readTurnServiceConfig({ ...env, TURN_EXTERNAL_IP: '' })).toBeUndefined();
    expect(readTurnServiceConfig({ ...env, TURN_PORT: '70000' })).toBeUndefined();
    expect(readTurnServiceConfig({ ...env, TURN_CREDENTIAL_TTL_SECONDS: '60' })).toBeUndefined();
    expect(readTurnServiceConfig({ ...env, TURN_RELAY_MIN_PORT: '50000', TURN_RELAY_MAX_PORT: '49000' })).toBeUndefined();
    expect(readTurnServiceConfig({ ...env, TURN_PORT: '49180' })).toBeUndefined();
    expect(readTurnServiceConfig({ ...env, TURN_RELAY_MIN_PORT: '49000', TURN_RELAY_MAX_PORT: '49256' })).toBeUndefined();
    expect(createTurnIceServers('user-a', { env: { ...env, TURN_ENABLED: 'false' } })).toEqual([
      'stun:stun.cloudflare.com:3478',
    ]);
  });
});
