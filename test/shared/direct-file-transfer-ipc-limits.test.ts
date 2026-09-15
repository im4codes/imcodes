import { describe, expect, it } from 'vitest';
import {
  DIRECT_FILE_TRANSFER_HOST_METHOD,
  DIRECT_FILE_TRANSFER_LIMITS,
  DIRECT_FILE_TRANSFER_MSG,
  DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
  validateDirectFileTransferDaemonCommand,
  DIRECT_FILE_TRANSFER_IPC_LIMITS as LIMITS,
  DIRECT_FILE_TRANSFER_WORKER_MSG,
  DIRECT_FILE_TRANSFER_WORKER_PROTOCOL_VERSION,
  isWithinDirectFileTransferIpcLimits,
  validateDirectFileTransferWorkerEnvelope,
} from '../../shared/direct-file-transfer.js';

/**
 * Everything crossing the worker boundary is structured-cloned. Clone is happy
 * to copy a payload that is enormous, deeply nested, or full of file bytes —
 * and doing that on the main thread is the exact stall the worker split exists
 * to remove. So the bound has to be checked before the clone, and it has to
 * mean the same thing the clone does.
 */
describe('direct file transfer IPC boundary limits', () => {
  const nest = (depth: number): unknown => {
    let value: unknown = 'leaf';
    for (let i = 0; i < depth; i += 1) value = { next: value };
    return value;
  };

  describe('size boundaries hold exactly at the limit', () => {
    it('accepts the deepest allowed value and refuses one level more', () => {
      // depth 0 is the value itself, so MAX_DEPTH nestings is the last accepted one.
      expect(isWithinDirectFileTransferIpcLimits(nest(LIMITS.MAX_DEPTH))).toBe(true);
      expect(isWithinDirectFileTransferIpcLimits(nest(LIMITS.MAX_DEPTH + 1))).toBe(false);
    });

    it('accepts the longest allowed string and refuses one character more', () => {
      expect(isWithinDirectFileTransferIpcLimits('x'.repeat(LIMITS.MAX_STRING_LENGTH))).toBe(true);
      expect(isWithinDirectFileTransferIpcLimits('x'.repeat(LIMITS.MAX_STRING_LENGTH + 1))).toBe(false);
    });

    it('refuses many individually legal strings that together blow the budget', () => {
      // The per-string limit alone cannot catch this: every element is legal.
      const chunk = 'x'.repeat(LIMITS.MAX_STRING_LENGTH);
      const count = Math.ceil(LIMITS.MAX_TOTAL_STRING_BUDGET / LIMITS.MAX_STRING_LENGTH);
      expect(isWithinDirectFileTransferIpcLimits(Array.from({ length: count }, () => chunk))).toBe(true);
      expect(isWithinDirectFileTransferIpcLimits(Array.from({ length: count + 1 }, () => chunk))).toBe(false);
    });

    it('accepts the longest allowed array and refuses one element more', () => {
      expect(isWithinDirectFileTransferIpcLimits(new Array(LIMITS.MAX_ARRAY_LENGTH).fill(1))).toBe(true);
      expect(isWithinDirectFileTransferIpcLimits(new Array(LIMITS.MAX_ARRAY_LENGTH + 1).fill(1))).toBe(false);
    });

    it('accepts the widest allowed record and refuses one key more', () => {
      const wide = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
      expect(isWithinDirectFileTransferIpcLimits(wide(LIMITS.MAX_KEYS))).toBe(true);
      expect(isWithinDirectFileTransferIpcLimits(wide(LIMITS.MAX_KEYS + 1))).toBe(false);
    });

    it('bounds key names too, not only values', () => {
      expect(isWithinDirectFileTransferIpcLimits({ ['k'.repeat(LIMITS.MAX_STRING_LENGTH + 1)]: 1 })).toBe(false);
    });

    it('counts depth through arrays as well as records, so nesting cannot be laundered', () => {
      let viaArrays: unknown = 'leaf';
      for (let i = 0; i < LIMITS.MAX_DEPTH + 1; i += 1) viaArrays = [viaArrays];
      expect(isWithinDirectFileTransferIpcLimits(viaArrays)).toBe(false);
    });
  });

  describe('binary never crosses', () => {
    const payload = Uint8Array.from([1, 2, 3]);

    it('refuses typed arrays, buffers and raw ArrayBuffers', () => {
      expect(isWithinDirectFileTransferIpcLimits(payload)).toBe(false);
      expect(isWithinDirectFileTransferIpcLimits(Buffer.from('file bytes'))).toBe(false);
      expect(isWithinDirectFileTransferIpcLimits(new ArrayBuffer(8))).toBe(false);
      expect(isWithinDirectFileTransferIpcLimits(new DataView(new ArrayBuffer(8)))).toBe(false);
    });

    it('refuses binary nested inside an otherwise ordinary payload', () => {
      // The realistic shape: a control message that quietly carries a chunk.
      expect(isWithinDirectFileTransferIpcLimits({ ok: true, chunk: payload })).toBe(false);
      expect(isWithinDirectFileTransferIpcLimits({ frames: [{ data: Buffer.from('bytes') }] })).toBe(false);
    });

    it('does not let a typed array pass as an ordinary indexed record', () => {
      // A Uint8Array enumerates as {0:1,1:2,2:3}. Checked in the wrong order it
      // reads as a small, entirely legal object.
      expect(Object.keys(payload)).toEqual(['0', '1', '2']);
      expect(isWithinDirectFileTransferIpcLimits(payload)).toBe(false);
    });
  });

  describe('semantics, not only size', () => {
    it('refuses values whose meaning would not survive the boundary', () => {
      // structuredClone throws on these outright.
      expect(isWithinDirectFileTransferIpcLimits(Symbol('claim'))).toBe(false);
      expect(isWithinDirectFileTransferIpcLimits(() => 'send')).toBe(false);
      // These clone, but arrive as something the protocol never described.
      expect(isWithinDirectFileTransferIpcLimits(new Map([['a', 1]]))).toBe(false);
      expect(isWithinDirectFileTransferIpcLimits(new Set([1]))).toBe(false);
      expect(isWithinDirectFileTransferIpcLimits(new Date())).toBe(false);
      expect(isWithinDirectFileTransferIpcLimits(new Error('boom'))).toBe(false);
      class Lease { id = 'x'; }
      expect(isWithinDirectFileTransferIpcLimits(new Lease())).toBe(false);
    });

    it('refuses non-finite numbers, which clone but mean nothing as a count', () => {
      expect(isWithinDirectFileTransferIpcLimits({ received: Number.NaN })).toBe(false);
      expect(isWithinDirectFileTransferIpcLimits({ received: Number.POSITIVE_INFINITY })).toBe(false);
      expect(isWithinDirectFileTransferIpcLimits({ received: 0 })).toBe(true);
    });

    it('accepts the ordinary control payload shape', () => {
      expect(isWithinDirectFileTransferIpcLimits({
        type: 'direct_file.status', state: 'committed', received: 5,
        attachment: { id: 'a', downloadable: true }, detail: null, optional: undefined,
      })).toBe(true);
    });

    it('everything it accepts really does survive a structured clone', () => {
      // The guard is only meaningful if acceptance implies cloneability.
      const accepted: unknown[] = [
        null, undefined, true, 0, -1.5, 'text', [], {},
        nest(LIMITS.MAX_DEPTH), new Array(LIMITS.MAX_ARRAY_LENGTH).fill('x'),
        { nested: [{ deep: { value: 1 } }] },
      ];
      for (const value of accepted) {
        expect(isWithinDirectFileTransferIpcLimits(value), String(value)).toBe(true);
        expect(() => structuredClone(value), String(value)).not.toThrow();
      }
    });
  });

  /**
   * The bound is a backstop, not a second opinion on the protocol. If it is
   * tighter than what the protocol declares legal, it does not protect the main
   * thread — it silently deletes real traffic, and the failure looks like a
   * transfer that just never negotiates.
   */
  describe('the bound can never reject a protocol-legal message', () => {
    const leaseOffer = (sdpBytes: number) => ({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      serverId: 'daemon-0001', browserTabId: 'browser-tab-0001', leaseId: 'lease-0001',
      leaseGeneration: 1, daemonGeneration: 1, requestId: 'request-0001',
      sdp: `v=0\r\n${'a'.repeat(sdpBytes - 5)}`,
    });

    it('accepts an offer carrying the largest SDP the protocol allows', () => {
      const maximal = leaseOffer(DIRECT_FILE_TRANSFER_LIMITS.SDP_BYTES);
      expect(validateDirectFileTransferDaemonCommand(maximal).ok, 'the protocol calls this legal').toBe(true);
      // A real multi-candidate offer is routinely several times larger than a
      // hand-written one, so this is the case that matters in production.
      expect(isWithinDirectFileTransferIpcLimits(maximal), 'so the IPC bound must carry it').toBe(true);
      expect(
        validateDirectFileTransferWorkerEnvelope({
          v: DIRECT_FILE_TRANSFER_WORKER_PROTOCOL_VERSION, generation: 1,
          type: DIRECT_FILE_TRANSFER_WORKER_MSG.COMMAND, senderId: 's1', command: maximal,
        }),
        'and it must cross the worker boundary',
      ).toBeTruthy();
    });

    it('carries the largest ICE candidate the protocol allows', () => {
      const candidate = {
        type: DIRECT_FILE_TRANSFER_MSG.LEASE_ICE,
        protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
        serverId: 'daemon-0001', browserTabId: 'browser-tab-0001', leaseId: 'lease-0001',
        leaseGeneration: 1, daemonGeneration: 1, requestId: 'request-0001',
        candidate: 'a'.repeat(DIRECT_FILE_TRANSFER_LIMITS.ICE_CANDIDATE_BYTES), mid: '0',
      };
      expect(validateDirectFileTransferDaemonCommand(candidate).ok).toBe(true);
      expect(isWithinDirectFileTransferIpcLimits(candidate)).toBe(true);
    });

    it('states the relationship as a rule, not a coincidence', () => {
      // Whoever next tightens the IPC limit reads this line.
      expect(LIMITS.MAX_STRING_LENGTH).toBeGreaterThanOrEqual(DIRECT_FILE_TRANSFER_LIMITS.SDP_BYTES);
      expect(LIMITS.MAX_STRING_LENGTH).toBeGreaterThanOrEqual(DIRECT_FILE_TRANSFER_LIMITS.ICE_CANDIDATE_BYTES);
      expect(LIMITS.MAX_TOTAL_STRING_BUDGET).toBeGreaterThanOrEqual(LIMITS.MAX_STRING_LENGTH);
    });
  });

  describe('the envelope validator applies the bound on every payload-carrying type', () => {
    const base = { v: DIRECT_FILE_TRANSFER_WORKER_PROTOCOL_VERSION, generation: 1 };
    const oversized = { chunk: Buffer.from('file bytes') };
    const legal = { ok: true };

    const cases: Array<{ name: string; build: (payload: unknown) => Record<string, unknown> }> = [
      { name: 'COMMAND', build: (payload) => ({ ...base, type: DIRECT_FILE_TRANSFER_WORKER_MSG.COMMAND, senderId: 's1', command: payload }) },
      { name: 'CONTROL', build: (payload) => ({ ...base, type: DIRECT_FILE_TRANSFER_WORKER_MSG.CONTROL, senderId: 's1', message: payload, emittedAt: 1 }) },
      { name: 'HOST_CALL', build: (payload) => ({ ...base, type: DIRECT_FILE_TRANSFER_WORKER_MSG.HOST_CALL, callId: 'c1', method: DIRECT_FILE_TRANSFER_HOST_METHOD.TRY_CLAIM_CLIENT_UPLOAD, args: [payload] }) },
      { name: 'HOST_RESULT', build: (payload) => ({ ...base, type: DIRECT_FILE_TRANSFER_WORKER_MSG.HOST_RESULT, callId: 'c1', ok: true, value: payload }) },
    ];

    for (const { name, build } of cases) {
      it(`${name} is accepted within the bound and refused outside it`, () => {
        expect(validateDirectFileTransferWorkerEnvelope(build(legal)), `${name} accepts a legal payload`).toBeTruthy();
        expect(validateDirectFileTransferWorkerEnvelope(build(oversized)), `${name} refuses binary`).toBeUndefined();
        expect(validateDirectFileTransferWorkerEnvelope(build(nest(LIMITS.MAX_DEPTH + 2))), `${name} refuses over-deep`).toBeUndefined();
        expect(validateDirectFileTransferWorkerEnvelope(build('x'.repeat(LIMITS.MAX_STRING_LENGTH + 1))), `${name} refuses over-long`).toBeUndefined();
      });
    }
  });
});
