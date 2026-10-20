import { describe, expect, it } from 'vitest';

import {
  MACOS_VIRTUAL_DISPLAY_MAX_PENDING,
  MACOS_VIRTUAL_DISPLAY_PENDING_ERROR,
  MacosVirtualDisplayPendingRegistry,
  type MacosVirtualDisplayChannelIdentity,
} from '../../src/node/macos-virtual-display-pending.js';

const IDENTITY: MacosVirtualDisplayChannelIdentity = Object.freeze({
  workerGeneration: 7,
  auditSessionId: 100_003,
  serviceGeneration: 3,
  leaseId: 11,
});

const bound = (): MacosVirtualDisplayPendingRegistry => {
  const registry = new MacosVirtualDisplayPendingRegistry();
  registry.bind(IDENTITY);
  return registry;
};

describe('macOS virtual-display pending lifecycle', () => {
  it('refuses a late answer to a request that already timed out', () => {
    // A -> timeout -> B. The late answer to A must not settle B, and it must
    // not settle A either: A is gone. Correlating on request id alone matched
    // the late frame to whatever was outstanding.
    const registry = bound();
    expect(registry.admit(IDENTITY, 1).ok).toBe(true);
    registry.abandon(1);                       // A timed out
    expect(registry.admit(IDENTITY, 2).ok).toBe(true);   // B
    expect(registry.settle(IDENTITY, 1)).toBe(false);    // late A
    expect(registry.pending).toBe(1);                    // B still in flight
    expect(registry.settle(IDENTITY, 2)).toBe(true);
  });

  it('never re-admits an id that was already spent in this generation', () => {
    const registry = bound();
    expect(registry.admit(IDENTITY, 5).ok).toBe(true);
    expect(registry.settle(IDENTITY, 5)).toBe(true);
    // Same id again is not a fresh request; a late answer for the first would
    // otherwise settle the second.
    expect(registry.admit(IDENTITY, 5)).toMatchObject({
      ok: false, error: MACOS_VIRTUAL_DISPLAY_PENDING_ERROR.NOT_FRESH,
    });
    expect(registry.admit(IDENTITY, 4)).toMatchObject({
      ok: false, error: MACOS_VIRTUAL_DISPLAY_PENDING_ERROR.NOT_FRESH,
    });
    expect(registry.admit(IDENTITY, 6).ok).toBe(true);
  });

  it('refuses a duplicate that is still outstanding', () => {
    const registry = bound();
    expect(registry.admit(IDENTITY, 1).ok).toBe(true);
    expect(registry.admit(IDENTITY, 1)).toMatchObject({
      ok: false, error: MACOS_VIRTUAL_DISPLAY_PENDING_ERROR.DUPLICATE,
    });
  });

  it('is bounded', () => {
    const registry = bound();
    for (let id = 1; id <= MACOS_VIRTUAL_DISPLAY_MAX_PENDING; id += 1) {
      expect(registry.admit(IDENTITY, id).ok, `id ${id}`).toBe(true);
    }
    expect(registry.admit(IDENTITY, MACOS_VIRTUAL_DISPLAY_MAX_PENDING + 1))
      .toMatchObject({ ok: false, error: MACOS_VIRTUAL_DISPLAY_PENDING_ERROR.FULL });
  });

  it('drops an answer authored by a replaced agent lease', () => {
    const registry = bound();
    expect(registry.admit(IDENTITY, 1).ok).toBe(true);
    // The agent reconnected. Same worker, same ASID, same service generation,
    // different connection -- and a well-formed answer from the old one.
    const released = { ...IDENTITY, leaseId: IDENTITY.leaseId + 1 };
    registry.bind(released);
    expect(registry.pending).toBe(0);
    expect(registry.settle(IDENTITY, 1)).toBe(false);
    expect(registry.settle(released, 1)).toBe(false);
  });

  it('drops an answer addressed to a superseded worker generation', () => {
    const registry = bound();
    expect(registry.admit(IDENTITY, 1).ok).toBe(true);
    const next = { ...IDENTITY, workerGeneration: IDENTITY.workerGeneration + 1 };
    registry.bind(next);
    expect(registry.settle(IDENTITY, 1)).toBe(false);
    expect(registry.admit(IDENTITY, 2)).toMatchObject({
      ok: false, error: MACOS_VIRTUAL_DISPLAY_PENDING_ERROR.IDENTITY_CHANGED,
    });
  });

  it('drops an answer from a different audit session or service generation', () => {
    for (const changed of [
      { ...IDENTITY, auditSessionId: IDENTITY.auditSessionId + 1 },
      { ...IDENTITY, serviceGeneration: IDENTITY.serviceGeneration + 1 },
    ]) {
      const registry = bound();
      expect(registry.admit(IDENTITY, 1).ok).toBe(true);
      registry.bind(changed);
      expect(registry.settle(IDENTITY, 1)).toBe(false);
    }
  });

  it('fails every request in flight when the channel goes terminal', () => {
    // EOF, a malformed frame or a dead lease. None of them may leave a caller
    // waiting on an answer that can no longer arrive.
    const registry = bound();
    expect(registry.admit(IDENTITY, 1).ok).toBe(true);
    expect(registry.admit(IDENTITY, 2).ok).toBe(true);
    expect(registry.close()).toBe(2);
    expect(registry.isTerminal).toBe(true);
    expect(registry.settle(IDENTITY, 1)).toBe(false);
    expect(registry.admit(IDENTITY, 3)).toMatchObject({
      ok: false, error: MACOS_VIRTUAL_DISPLAY_PENDING_ERROR.TERMINAL,
    });
    // Only a fresh bind reopens it, and it starts with nothing in flight.
    registry.bind(IDENTITY);
    expect(registry.isTerminal).toBe(false);
    expect(registry.pending).toBe(0);
    expect(registry.admit(IDENTITY, 1).ok).toBe(true);
  });

  it('refuses to bind an incomplete identity at all', () => {
    for (const partial of [
      { ...IDENTITY, workerGeneration: 0 },
      { ...IDENTITY, auditSessionId: 0 },
      { ...IDENTITY, serviceGeneration: 0 },
      { ...IDENTITY, leaseId: 0 },
    ]) {
      const registry = new MacosVirtualDisplayPendingRegistry();
      registry.bind(partial);
      expect(registry.isTerminal).toBe(true);
      expect(registry.admit(partial, 1).ok).toBe(false);
    }
  });

  it('does not cancel live requests when the same identity re-binds', () => {
    const registry = bound();
    expect(registry.admit(IDENTITY, 1).ok).toBe(true);
    registry.bind({ ...IDENTITY });
    expect(registry.pending).toBe(1);
    expect(registry.settle(IDENTITY, 1)).toBe(true);
  });
});
