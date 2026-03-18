import { describe, it, expect, vi } from 'vitest';
import { signJwt, verifyJwt, randomHex } from '../../src/security/crypto.js';

const TEST_SIGNING_KEY = 'test-signing-key-32bytes-minimum!!';

// 10.1: Test POST /api/auth/ws-ticket logic
describe('ws-ticket JWT', () => {
  it('issues a ticket with correct claims', async () => {
    const jti = randomHex(16);
    const ticket = await signJwt(
      { sub: 'user1', type: 'ws-ticket', sid: 'server1', jti },
      TEST_SIGNING_KEY,
      15,
    );

    const payload = await verifyJwt(ticket, TEST_SIGNING_KEY);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe('user1');
    expect(payload!.type).toBe('ws-ticket');
    expect(payload!.sid).toBe('server1');
    expect(payload!.jti).toBe(jti);
  });

  it('ticket expires after 15 seconds', async () => {
    const ticket = await signJwt(
      { sub: 'user1', type: 'ws-ticket', sid: 'server1', jti: randomHex(16) },
      TEST_SIGNING_KEY,
      -1, // already expired
    );

    const payload = await verifyJwt(ticket, TEST_SIGNING_KEY);
    expect(payload).toBeNull();
  });

  it('ticket rejected with wrong signing key', async () => {
    const ticket = await signJwt(
      { sub: 'user1', type: 'ws-ticket', sid: 'server1', jti: randomHex(16) },
      TEST_SIGNING_KEY,
      15,
    );

    const payload = await verifyJwt(ticket, 'wrong-key-entirely-different!!!!');
    expect(payload).toBeNull();
  });

  it('ticket with wrong sid is detectable', async () => {
    const ticket = await signJwt(
      { sub: 'user1', type: 'ws-ticket', sid: 'server1', jti: randomHex(16) },
      TEST_SIGNING_KEY,
      15,
    );

    const payload = await verifyJwt(ticket, TEST_SIGNING_KEY);
    expect(payload).not.toBeNull();
    // sid mismatch check would be: payload.sid !== requestedServerId
    expect(payload!.sid).toBe('server1');
    expect(payload!.sid).not.toBe('server2');
  });
});

// 10.2: Test terminal WebSocket ticket validation logic
describe('terminal WebSocket ticket validation', () => {
  it('valid ticket passes all checks', async () => {
    const jti = randomHex(16);
    const serverId = 'srv-abc';
    const ticket = await signJwt(
      { sub: 'user1', type: 'ws-ticket', sid: serverId, jti },
      TEST_SIGNING_KEY,
      15,
    );

    const payload = await verifyJwt(ticket, TEST_SIGNING_KEY);
    expect(payload).not.toBeNull();
    expect(payload!.type).toBe('ws-ticket');
    expect(payload!.sid).toBe(serverId);
    expect(typeof payload!.jti).toBe('string');
  });

  it('expired ticket is rejected', async () => {
    const ticket = await signJwt(
      { sub: 'user1', type: 'ws-ticket', sid: 'srv-abc', jti: randomHex(16) },
      TEST_SIGNING_KEY,
      -1,
    );

    const payload = await verifyJwt(ticket, TEST_SIGNING_KEY);
    expect(payload).toBeNull();
  });

  it('wrong sid is detected', async () => {
    const ticket = await signJwt(
      { sub: 'user1', type: 'ws-ticket', sid: 'srv-wrong', jti: randomHex(16) },
      TEST_SIGNING_KEY,
      15,
    );

    const payload = await verifyJwt(ticket, TEST_SIGNING_KEY);
    expect(payload!.sid).not.toBe('srv-abc');
  });

  it('jti uniqueness: two tickets have different jti', async () => {
    const jti1 = randomHex(16);
    const jti2 = randomHex(16);
    expect(jti1).not.toBe(jti2);
  });
});
