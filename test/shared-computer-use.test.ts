import { describe, expect, it } from 'vitest';
import { DAEMON_COMMAND_TYPES } from '../shared/daemon-command-types.js';
import { DAEMON_MSG } from '../shared/daemon-events.js';
import {
  COMPUTER_USE_MIN_TIMEOUT_MS,
  COMPUTER_USE_MAX_TIMEOUT_MS,
  decodeComputerUseHttpEnvelope,
  encodeComputerUseHttpEnvelope,
  validateComputerUseFrame,
  validateComputerUseResultFrame,
} from '../shared/computer-use.js';

const correlationId = '1234567890abcdef';

describe('computer-use shared protocol', () => {
  it('validates strict request frames including shell_session1', () => {
    expect(validateComputerUseFrame({
      type: DAEMON_COMMAND_TYPES.COMPUTER_USE,
      correlationId,
      tool: 'shell_session1',
      arguments: { command: 'whoami' },
      timeoutMs: COMPUTER_USE_MIN_TIMEOUT_MS,
    }).ok).toBe(true);
    expect(validateComputerUseFrame({ type: DAEMON_COMMAND_TYPES.COMPUTER_USE, correlationId, tool: 'nope' }).ok).toBe(false);
    expect(validateComputerUseFrame({ type: DAEMON_COMMAND_TYPES.COMPUTER_USE, correlationId, tool: 'list_apps', serverId: 'forged' })).toEqual({ ok: false, error: 'unknown_field:serverId' });
    expect(validateComputerUseFrame({ type: DAEMON_COMMAND_TYPES.COMPUTER_USE, correlationId, tool: 'list_apps', timeoutMs: COMPUTER_USE_MAX_TIMEOUT_MS + 1 }).ok).toBe(false);
  });

  it('validates strict result frames and HTTP envelopes', () => {
    const result = {
      type: DAEMON_MSG.COMPUTER_USE_RESULT,
      correlationId,
      ok: true,
      tool: 'list_apps',
      content: [{ type: 'text', text: '[]' }],
      durationMs: 1,
    } as const;
    expect(validateComputerUseResultFrame(result).ok).toBe(true);
    expect(validateComputerUseResultFrame({ ...result, requestId: 'forged' }).ok).toBe(false);
    const { type: _type, ...payload } = result;
    const env = encodeComputerUseHttpEnvelope('completed', payload);
    expect(decodeComputerUseHttpEnvelope(env).ok).toBe(true);
    expect(decodeComputerUseHttpEnvelope({ ...env, outcome: 'completed', result: undefined }).ok).toBe(false);
  });
});
