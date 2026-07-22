import { describe, expect, it } from 'vitest';
import { createCcPresetDraftFromPreset } from '../src/components/cc-preset-form.js';

describe('CC preset form', () => {
  it('shows the migrated 1M window for legacy MiniMax-M3 presets', () => {
    const draft = createCcPresetDraftFromPreset({
      name: 'minimax',
      env: { ANTHROPIC_MODEL: 'MiniMax-M3' },
      defaultModel: 'MiniMax-M3',
      contextWindow: 200_000,
    });

    expect(draft.contextWindow).toBe('1000000');
  });

  it('does not rewrite another model\'s explicit 200K window', () => {
    const draft = createCcPresetDraftFromPreset({
      name: 'custom',
      env: { ANTHROPIC_MODEL: 'custom-model' },
      contextWindow: 200_000,
    });

    expect(draft.contextWindow).toBe('200000');
  });
});
