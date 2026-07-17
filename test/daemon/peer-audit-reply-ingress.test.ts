import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PEER_AUDIT_REPLY_VERSION } from '../../shared/peer-audit.js';

const getSessionMock = vi.fn();
vi.mock('../../src/store/session-store.js', () => ({
  getSession: (...args: unknown[]) => getSessionMock(...args),
}));

import {
  PeerAuditReplyRateLimiter,
  clearPeerAuditReplyIngressRateLimits,
  decodePeerAuditReplyCommandStructure,
  peerAuditCapabilityMatches,
  registerPeerAuditReplyIngressHandler,
  submitPeerAuditReply,
} from '../../src/daemon/peer-audit-reply-ingress.js';

const capability = 'A'.repeat(32);
const valid = {
  version: PEER_AUDIT_REPLY_VERSION,
  attemptId: 'attempt_1',
  replyCapability: capability,
  verdict: 'PASS',
  findings: 'Reviewed and validated.',
  validations: [{ kind: 'test', label: 'focused', outcome: 'passed', summary: '1 passed' }],
};

describe('peer audit reply ingress', () => {
  beforeEach(() => {
    clearPeerAuditReplyIngressRateLimits();
    registerPeerAuditReplyIngressHandler(null);
    getSessionMock.mockReset();
    getSessionMock.mockReturnValue({
      name: 'deck_sub_a', state: 'idle', sessionInstanceId: 'instance_1', runtimeEpoch: 'epoch_1',
    });
  });

  it('binds the live sender record and forwards only a strict envelope', async () => {
    const handler = vi.fn().mockReturnValue({ ok: true });
    registerPeerAuditReplyIngressHandler(handler);
    await expect(submitPeerAuditReply({
      rawBody: JSON.stringify(valid), senderSessionName: 'deck_sub_a', now: 100,
    })).resolves.toEqual({ ok: true });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      envelope: valid,
      sender: expect.objectContaining({ name: 'deck_sub_a', sessionInstanceId: 'instance_1' }),
      receivedAt: 100,
    }));
  });

  it('defers PASS evidence policy until after capability and identity validation', async () => {
    const handler = vi.fn().mockReturnValue({ ok: false, error: 'invalid_capability' });
    registerPeerAuditReplyIngressHandler(handler);
    await expect(submitPeerAuditReply({
      rawBody: JSON.stringify({ ...valid, validations: [] }),
      senderSessionName: 'deck_sub_a',
      now: 101,
    })).resolves.toEqual({ ok: false, error: 'invalid_capability' });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      envelope: expect.objectContaining({ verdict: 'PASS', validations: [] }),
    }));
  });

  it('fails closed for malformed, unknown-key, unavailable sender, and unavailable daemon handler', async () => {
    await expect(submitPeerAuditReply({
      rawBody: JSON.stringify({ ...valid, extra: true }), senderSessionName: 'deck_sub_a', now: 1,
    })).resolves.toMatchObject({ ok: false });
    getSessionMock.mockReturnValue(undefined);
    await expect(submitPeerAuditReply({
      rawBody: JSON.stringify(valid), senderSessionName: 'deck_sub_a', now: 2,
    })).resolves.toEqual({ ok: false, error: 'sender_unavailable' });
    getSessionMock.mockReturnValue({ name: 'deck_sub_a', state: 'idle' });
    await expect(submitPeerAuditReply({
      rawBody: JSON.stringify(valid), senderSessionName: 'deck_sub_a', now: 3,
    })).resolves.toEqual({ ok: false, error: 'sender_unavailable' });
    getSessionMock.mockReturnValue({
      name: 'deck_sub_a', state: 'idle', sessionInstanceId: 'instance_1', runtimeEpoch: 'epoch_1',
    });
    await expect(submitPeerAuditReply({
      rawBody: JSON.stringify(valid), senderSessionName: 'deck_sub_a', now: 4,
    })).resolves.toEqual({ ok: false, error: 'ingress_unavailable' });
  });

  it('applies raw-size and strict-schema rejection before sender lookup', async () => {
    getSessionMock.mockClear();
    await expect(submitPeerAuditReply({
      rawBody: '{"unknown":true}',
      senderSessionName: 'deck_sub_missing',
      now: 1,
    })).resolves.toMatchObject({ ok: false });
    expect(getSessionMock).not.toHaveBeenCalled();

    await expect(submitPeerAuditReply({
      rawBody: '你'.repeat(9_000),
      senderSessionName: 'deck_sub_missing',
      now: 2,
    })).resolves.toEqual({ ok: false, error: 'oversize' });
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it('uses an independent bounded sender rate limit', async () => {
    registerPeerAuditReplyIngressHandler(() => ({ ok: false, error: 'invalid_capability' }));
    for (let i = 0; i < 12; i += 1) {
      const result = await submitPeerAuditReply({ rawBody: JSON.stringify(valid), senderSessionName: 'deck_sub_a', now: i + 1 });
      expect(result).toEqual({ ok: false, error: 'invalid_capability' });
    }
    await expect(submitPeerAuditReply({
      rawBody: JSON.stringify(valid), senderSessionName: 'deck_sub_a', now: 20,
    })).resolves.toEqual({ ok: false, error: 'rate_limited' });
  });

  it('keys ingress rate limits by logical instance and runtime epoch, not reusable name', async () => {
    registerPeerAuditReplyIngressHandler(() => ({ ok: false, error: 'invalid_capability' }));
    for (let i = 0; i < 12; i += 1) {
      await submitPeerAuditReply({ rawBody: JSON.stringify(valid), senderSessionName: 'deck_sub_a', now: i + 1 });
    }
    await expect(submitPeerAuditReply({
      rawBody: JSON.stringify(valid), senderSessionName: 'deck_sub_a', now: 20,
    })).resolves.toEqual({ ok: false, error: 'rate_limited' });

    getSessionMock.mockReturnValue({
      name: 'deck_sub_a', state: 'idle', sessionInstanceId: 'instance_recreated', runtimeEpoch: 'epoch_1',
    });
    await expect(submitPeerAuditReply({
      rawBody: JSON.stringify(valid), senderSessionName: 'deck_sub_a', now: 21,
    })).resolves.toEqual({ ok: false, error: 'invalid_capability' });

    getSessionMock.mockReturnValue({
      name: 'deck_sub_a', state: 'idle', sessionInstanceId: 'instance_recreated', runtimeEpoch: 'epoch_replaced',
    });
    await expect(submitPeerAuditReply({
      rawBody: JSON.stringify(valid), senderSessionName: 'deck_sub_a', now: 22,
    })).resolves.toEqual({ ok: false, error: 'invalid_capability' });
  });

  it('bounds limiter state with TTL and LRU eviction', () => {
    const ttl = new PeerAuditReplyRateLimiter({ windowMs: 10, maxArrivals: 1, ttlMs: 20, capacity: 2 });
    const a = { sessionInstanceId: 'a', runtimeEpoch: 'one' };
    expect(ttl.admit(a, 0)).toBe(true);
    expect(ttl.admit(a, 1)).toBe(false);
    expect(ttl.size).toBe(1);
    expect(ttl.admit(a, 21)).toBe(true);

    const lru = new PeerAuditReplyRateLimiter({ windowMs: 100, maxArrivals: 1, ttlMs: 1_000, capacity: 2 });
    const b = { sessionInstanceId: 'b', runtimeEpoch: 'one' };
    const c = { sessionInstanceId: 'c', runtimeEpoch: 'one' };
    expect(lru.admit(a, 0)).toBe(true);
    expect(lru.admit(b, 1)).toBe(true);
    expect(lru.admit(a, 2)).toBe(false); // Touch A; B is now least recently used.
    expect(lru.admit(c, 3)).toBe(true);
    expect(lru.size).toBe(2);
    expect(lru.admit(b, 4)).toBe(true); // B was evicted, so it has a fresh bucket.
    expect(lru.size).toBe(2);
  });

  it('does not allocate rate-limit buckets for nonexistent sender names', async () => {
    getSessionMock.mockReturnValue(undefined);
    for (let i = 0; i < 100; i += 1) {
      await expect(submitPeerAuditReply({
        rawBody: JSON.stringify(valid),
        senderSessionName: `deck_sub_missing${i}`,
        now: i + 1,
      })).resolves.toEqual({ ok: false, error: 'sender_unavailable' });
    }
    getSessionMock.mockReturnValue({
      name: 'deck_sub_recovered', state: 'idle', sessionInstanceId: 'instance_2', runtimeEpoch: 'epoch_2',
    });
    registerPeerAuditReplyIngressHandler(() => ({ ok: false, error: 'invalid_capability' }));
    await expect(submitPeerAuditReply({
      rawBody: JSON.stringify(valid), senderSessionName: 'deck_sub_recovered', now: 200,
    })).resolves.toEqual({ ok: false, error: 'invalid_capability' });
  });

  it('compares capabilities without prefix or length equivalence', () => {
    expect(peerAuditCapabilityMatches(capability, capability)).toBe(true);
    expect(peerAuditCapabilityMatches(capability, `${capability}A`)).toBe(false);
    expect(peerAuditCapabilityMatches(capability, `${capability.slice(0, -1)}B`)).toBe(false);
  });

  it('provides one structure-only seam for versioned CLI and versionless MCP inputs', () => {
    const withoutVersion = { ...valid, validations: [] } as Record<string, unknown>;
    delete withoutVersion.version;
    expect(decodePeerAuditReplyCommandStructure(withoutVersion)).toEqual({
      ok: true,
      value: { ...valid, validations: [] },
    });
    expect(decodePeerAuditReplyCommandStructure({ ...valid, validations: [] })).toEqual({
      ok: true,
      value: { ...valid, validations: [] },
    });
  });

  it('folds internal ingress reasons out of the public response', async () => {
    registerPeerAuditReplyIngressHandler(() => ({
      ok: false,
      error: 'identity_mismatch',
      internalReason: 'baseline_rejected',
    }));
    await expect(submitPeerAuditReply({
      rawBody: JSON.stringify(valid), senderSessionName: 'deck_sub_a', now: 100,
    })).resolves.toEqual({ ok: false, error: 'identity_mismatch' });
  });
});
