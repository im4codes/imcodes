import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createTurnIceServerAuthority,
  createTurnIceServers,
  readTurnServiceConfig,
} from '../src/ws/turn-credentials.js';
import { TURN_SERVICE_DEFAULTS } from '../../shared/turn-service.js';

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
    // CONTRACT CHANGE, deliberate: a 257-port range used to be refused because
    // the ceiling was 256 ports. That ceiling is what silently invalidated the
    // production 49201-50200 range and left both P2P features with no relay
    // candidate at all. The rule is now a resource cap of
    // TURN_SERVICE_DEFAULTS.RELAY_PORT_MAX_COUNT ports, exercised at its exact
    // boundary below, so a real coturn range is usable and a typo still is not.
    expect(readTurnServiceConfig({ ...env, TURN_RELAY_MIN_PORT: '49000', TURN_RELAY_MAX_PORT: '49256' })).toMatchObject({
      relayMinPort: 49_000,
      relayMaxPort: 49_256,
    });
    const maxCount = TURN_SERVICE_DEFAULTS.RELAY_PORT_MAX_COUNT;
    expect(readTurnServiceConfig({
      ...env,
      TURN_RELAY_MIN_PORT: '20000',
      TURN_RELAY_MAX_PORT: String(20_000 + maxCount - 1),
    }), `${maxCount} relay ports is the documented cap and must be usable`).toMatchObject({
      relayMaxPort: 20_000 + maxCount - 1,
    });
    expect(readTurnServiceConfig({
      ...env,
      TURN_RELAY_MIN_PORT: '20000',
      TURN_RELAY_MAX_PORT: String(20_000 + maxCount),
    }), 'one port past the cap must still fail closed').toBeUndefined();
    expect(createTurnIceServers('user-a', { env: { ...env, TURN_ENABLED: 'false' } })).toEqual([
      'stun:stun.cloudflare.com:3478',
    ]);
  });
});

/**
 * The production incident (2026-09-09): a phone on 5G could not open a direct
 * file transfer, and the Windows node downstairs could not open a remote
 * desktop session. Both reached SDP answer in two or three seconds and then
 * died with nothing to nominate, and coturn itself was healthy.
 *
 * The cause was here. im.zhinet.work publishes relay UDP 49201-50200, a span of
 * 999, and this module rejected the whole configuration over that span alone —
 * silently, falling back to a STUN-only list. So no client of either feature
 * ever received a TURN URL, and no relay candidate could exist.
 *
 * The installer, meanwhile, wrote that very range into .env, into coturn's
 * min-port/max-port and into the Docker publish range. The two halves of the
 * product disagreed about what a valid relay range is; that is what these pin.
 */
const PRODUCTION_ENV = {
  TURN_ENABLED: 'true',
  TURN_HOST: 'im.zhinet.work',
  TURN_PORT: '3480',
  TURN_EXTERNAL_IP: '43.248.99.95',
  // Correct LENGTH only. The real shared secret is never needed to exercise
  // range validation and must never appear in a test.
  TURN_SHARED_SECRET: 'x'.repeat(64),
  TURN_CREDENTIAL_TTL_SECONDS: '86400',
  TURN_RELAY_MIN_PORT: '49201',
  TURN_RELAY_MAX_PORT: '50200',
} as const;

function relayTransports(servers: ReturnType<typeof createTurnIceServers>): string[] {
  return servers
    .filter((entry): entry is Exclude<typeof entry, string> => typeof entry !== 'string')
    .flatMap((entry) => entry.urls);
}

describe('the production relay range is a valid relay range', () => {
  const nowMs = 1_780_000_000_000;

  it('accepts im.zhinet.work 49201-50200 and mints UDP + TCP relay material', () => {
    const authority = createTurnIceServerAuthority('user-mobile', { env: PRODUCTION_ENV, nowMs });
    expect(readTurnServiceConfig(PRODUCTION_ENV)).toMatchObject({
      host: 'im.zhinet.work',
      port: 3480,
      relayMinPort: 49_201,
      relayMaxPort: 50_200,
    });
    expect(relayTransports(authority.iceServers)).toEqual([
      'turn:im.zhinet.work:3480?transport=udp',
      'turn:im.zhinet.work:3480?transport=tcp',
    ]);
    expect(authority.credentialExpiresAt).toBe(nowMs + 86_400_000);
    expect(JSON.stringify(authority)).not.toContain(PRODUCTION_ENV.TURN_SHARED_SECRET);
  });

  it('still fails closed for ranges that are genuinely wrong', () => {
    // Inverted, out of bounds, listener inside the range, and a range so wide
    // that publishing it would be a typo rather than a deployment.
    expect(readTurnServiceConfig({ ...PRODUCTION_ENV, TURN_RELAY_MIN_PORT: '50201' })).toBeUndefined();
    expect(readTurnServiceConfig({ ...PRODUCTION_ENV, TURN_RELAY_MAX_PORT: '70000' })).toBeUndefined();
    expect(readTurnServiceConfig({ ...PRODUCTION_ENV, TURN_PORT: '49500' })).toBeUndefined();
    expect(readTurnServiceConfig({
      ...PRODUCTION_ENV,
      TURN_RELAY_MIN_PORT: '10000',
      TURN_RELAY_MAX_PORT: '60000',
    })).toBeUndefined();
  });

  it('still hands out STUN only when TURN is deliberately switched off', () => {
    const off = createTurnIceServerAuthority('user-mobile', {
      env: { ...PRODUCTION_ENV, TURN_ENABLED: 'false' },
      nowMs,
    });
    expect(relayTransports(off.iceServers)).toEqual([]);
    expect(off.iceServers).toEqual(['stun:stun.cloudflare.com:3478']);
  });
});
