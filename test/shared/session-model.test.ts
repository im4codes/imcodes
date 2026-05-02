import { describe, expect, it } from 'vitest';
import { resolveEffectiveSessionModel } from '../../shared/session-model.js';

describe('resolveEffectiveSessionModel', () => {
  it('uses one shared precedence for daemon relay and web footer model resolution', () => {
    expect(resolveEffectiveSessionModel({
      activeModel: ' gpt-5.5 ',
      requestedModel: 'gpt-5.4',
      modelDisplay: 'gpt-5',
      qwenModel: 'qwen3-coder-plus',
    }, 'fallback')).toBe('gpt-5.5');

    expect(resolveEffectiveSessionModel({
      requestedModel: 'gpt-5.5',
      modelDisplay: 'gpt-5.4',
    }, 'fallback')).toBe('gpt-5.5');

    expect(resolveEffectiveSessionModel({
      modelDisplay: 'gpt-5.5',
    }, 'fallback')).toBe('gpt-5.5');

    expect(resolveEffectiveSessionModel({
      qwenModel: 'qwen3-coder-plus',
    }, 'fallback')).toBe('qwen3-coder-plus');
  });

  it('trims blanks and falls back to event/detected models', () => {
    expect(resolveEffectiveSessionModel({
      activeModel: ' ',
      requestedModel: '',
      modelDisplay: null,
      qwenModel: undefined,
    }, undefined, ' gpt-5.5 ')).toBe('gpt-5.5');

    expect(resolveEffectiveSessionModel(null, '', '  ')).toBeUndefined();
  });
});
