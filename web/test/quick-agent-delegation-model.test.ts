import { beforeEach, describe, expect, it } from 'vitest';
import { CODEX_MODEL_STORAGE_KEY } from '../src/codex-model-preference.js';
import { resolveQuickAgentDelegationModel } from '../src/quick-agent-delegation-model.js';

describe('resolveQuickAgentDelegationModel', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('uses authoritative session metadata before live fallbacks', () => {
    expect(resolveQuickAgentDelegationModel({
      sessionName: 'deck_sub_cc',
      type: 'claude-code-sdk',
      activeModel: 'claude-opus-4-8',
    }, 'claude-sonnet-4-6', 'claude-haiku-4-5')).toBe('claude-opus-4-8');
  });

  it('uses the same detected and usage model fallbacks as the bottom session bar', () => {
    expect(resolveQuickAgentDelegationModel({
      sessionName: 'deck_sub_codex_detected',
      type: 'codex-sdk',
    }, 'gpt-5.6', 'gpt-5.5')).toBe('gpt-5.6');

    expect(resolveQuickAgentDelegationModel({
      sessionName: 'deck_sub_codex_usage',
      type: 'codex-sdk',
    }, null, 'gpt-5.6')).toBe('gpt-5.6');
  });

  it('uses the per-session legacy Codex preference only for model-less records', () => {
    localStorage.setItem(`${CODEX_MODEL_STORAGE_KEY}:deck_sub_legacy`, 'gpt-5.6');
    expect(resolveQuickAgentDelegationModel({
      sessionName: 'deck_sub_legacy',
      type: 'codex-sdk',
    })).toBe('gpt-5.6');
  });
});
