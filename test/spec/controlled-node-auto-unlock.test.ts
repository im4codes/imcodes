import { describe, expect, it } from 'vitest';
import {
  CONTROLLED_NODE_AUTO_UNLOCK_ACTION,
  CONTROLLED_NODE_AUTO_UNLOCK_ERROR,
  CONTROLLED_NODE_AUTO_UNLOCK_LIMITS,
  validateControlledNodeAutoUnlockCommand,
  validateControlledNodeAutoUnlockResult,
} from '../../shared/controlled-node-auto-unlock.js';

const TYPE = 'controlled_node.auto_unlock';
const RESULT_TYPE = 'controlled_node.auto_unlock_result';

describe('controlled-node auto unlock contract', () => {
  it('accepts a set that carries a secret and a clear that does not', () => {
    expect(validateControlledNodeAutoUnlockCommand({
      type: TYPE, requestId: 'req-1', action: CONTROLLED_NODE_AUTO_UNLOCK_ACTION.SET, secret: 'hunter2',
    }, TYPE)).toEqual({
      type: TYPE, requestId: 'req-1', action: 'set', secret: 'hunter2',
    });
    expect(validateControlledNodeAutoUnlockCommand({
      type: TYPE, requestId: 'req-2', action: CONTROLLED_NODE_AUTO_UNLOCK_ACTION.CLEAR,
    }, TYPE)).toEqual({ type: TYPE, requestId: 'req-2', action: 'clear' });
  });

  it('never lets a malformed frame clear a working secret or store an empty one', () => {
    // A set without a secret would otherwise store nothing while reporting success.
    expect(validateControlledNodeAutoUnlockCommand({
      type: TYPE, requestId: 'req', action: 'set',
    }, TYPE)).toBeNull();
    expect(validateControlledNodeAutoUnlockCommand({
      type: TYPE, requestId: 'req', action: 'set', secret: '',
    }, TYPE)).toBeNull();
    // A clear carrying a secret is contradictory and is refused rather than guessed.
    expect(validateControlledNodeAutoUnlockCommand({
      type: TYPE, requestId: 'req', action: 'clear', secret: 'hunter2',
    }, TYPE)).toBeNull();
    expect(validateControlledNodeAutoUnlockCommand({
      type: TYPE, requestId: 'req', action: 'wipe',
    }, TYPE)).toBeNull();
    expect(validateControlledNodeAutoUnlockCommand({
      type: 'other', requestId: 'req', action: 'clear',
    }, TYPE)).toBeNull();
    // Unknown keys are refused so a frame cannot smuggle extra instructions.
    expect(validateControlledNodeAutoUnlockCommand({
      type: TYPE, requestId: 'req', action: 'clear', persist: true,
    }, TYPE)).toBeNull();
  });

  it('bounds the secret length', () => {
    const limit = CONTROLLED_NODE_AUTO_UNLOCK_LIMITS.MAX_SECRET_LENGTH;
    expect(validateControlledNodeAutoUnlockCommand({
      type: TYPE, requestId: 'req', action: 'set', secret: 'a'.repeat(limit),
    }, TYPE)).not.toBeNull();
    expect(validateControlledNodeAutoUnlockCommand({
      type: TYPE, requestId: 'req', action: 'set', secret: 'a'.repeat(limit + 1),
    }, TYPE)).toBeNull();
  });

  it('accepts only a boolean-shaped reply and never a secret coming back', () => {
    expect(validateControlledNodeAutoUnlockResult({
      type: RESULT_TYPE, requestId: 'req', ok: true, configured: true,
    }, RESULT_TYPE)).toEqual({
      type: RESULT_TYPE, requestId: 'req', ok: true, configured: true,
    });
    expect(validateControlledNodeAutoUnlockResult({
      type: RESULT_TYPE, requestId: 'req', ok: false, configured: false,
      error: CONTROLLED_NODE_AUTO_UNLOCK_ERROR.UNSUPPORTED_PLATFORM,
    }, RESULT_TYPE)?.error).toBe('unsupported_platform');
    // A node must not be able to echo the stored value back to the Server.
    expect(validateControlledNodeAutoUnlockResult({
      type: RESULT_TYPE, requestId: 'req', ok: true, configured: true, secret: 'hunter2',
    }, RESULT_TYPE)).toBeNull();
    expect(validateControlledNodeAutoUnlockResult({
      type: RESULT_TYPE, requestId: 'req', ok: true, configured: 'yes',
    }, RESULT_TYPE)).toBeNull();
    expect(validateControlledNodeAutoUnlockResult({
      type: RESULT_TYPE, requestId: 'req', ok: true, configured: true, error: 'other',
    }, RESULT_TYPE)).toBeNull();
  });
});
