import { describe, expect, it } from 'vitest';
import { isMemoryEligibleEvent, MEMORY_EXCLUDED_EVENT_TYPES } from '../../shared/context-types.js';

describe('isMemoryEligibleEvent', () => {
  it('accepts assistant.text as memory-eligible', () => {
    expect(isMemoryEligibleEvent('assistant.text')).toBe(true);
  });

  it('accepts assistant.turn (legacy mapped event) as memory-eligible', () => {
    expect(isMemoryEligibleEvent('assistant.turn')).toBe(true);
  });

  it('accepts user.turn as memory-eligible', () => {
    expect(isMemoryEligibleEvent('user.turn')).toBe(true);
  });

  it('accepts user.message as memory-eligible', () => {
    expect(isMemoryEligibleEvent('user.message')).toBe(true);
  });

  it('accepts decision/constraint/preference as memory-eligible', () => {
    expect(isMemoryEligibleEvent('decision')).toBe(true);
    expect(isMemoryEligibleEvent('constraint')).toBe(true);
    expect(isMemoryEligibleEvent('preference')).toBe(true);
  });

  it('rejects assistant.delta (streaming)', () => {
    expect(isMemoryEligibleEvent('assistant.delta')).toBe(false);
  });

  it('rejects tool.call', () => {
    expect(isMemoryEligibleEvent('tool.call')).toBe(false);
  });

  it('rejects tool.result', () => {
    expect(isMemoryEligibleEvent('tool.result')).toBe(false);
  });

  it('rejects session.state', () => {
    expect(isMemoryEligibleEvent('session.state')).toBe(false);
  });

  it('rejects unknown event types', () => {
    expect(isMemoryEligibleEvent('some.random.event')).toBe(false);
    expect(isMemoryEligibleEvent('')).toBe(false);
    expect(isMemoryEligibleEvent('assistant.thinking')).toBe(false);
  });

  it('MEMORY_EXCLUDED_EVENT_TYPES are all rejected by isMemoryEligibleEvent', () => {
    for (const excluded of MEMORY_EXCLUDED_EVENT_TYPES) {
      expect(isMemoryEligibleEvent(excluded)).toBe(false);
    }
  });
});
