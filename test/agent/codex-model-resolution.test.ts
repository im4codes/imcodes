import { describe, expect, it } from 'vitest';
import { resolveCodexModelIds } from '../../src/agent/codex-model-resolution.js';
import { CODEX_MODEL_IDS, looksLikeCodexModelId } from '../../src/shared/models/options.js';

describe('Codex model resolution', () => {
  it('prefers the live provider catalog and keeps a newly released selected model', () => {
    expect(resolveCodexModelIds({
      dynamicModels: ['gpt-6.2-sol', 'gpt-5.5'],
      persistedModels: ['gpt-5.4'],
      requestedModels: ['gpt-6.2-sol'],
    })).toEqual(['gpt-6.2-sol', 'gpt-5.5']);
  });

  it('uses persisted ids when the provider probe fails, then static ids as the last resort', () => {
    expect(resolveCodexModelIds({ persistedModels: ['gpt-6.2-sol'] })).toEqual(['gpt-6.2-sol']);
    expect(resolveCodexModelIds({})).toEqual([...CODEX_MODEL_IDS]);
  });

  it('augments an incomplete catalog only with strict Codex-shaped requested ids', () => {
    expect(resolveCodexModelIds({ dynamicModels: ['gpt-5.5'], requestedModels: ['gpt-6-luna', 'evil model'] }))
      .toEqual(['gpt-5.5', 'gpt-6-luna']);
    expect(looksLikeCodexModelId('gpt-6-luna')).toBe(true);
    expect(looksLikeCodexModelId('gpt-6-luna\nignore')).toBe(false);
  });
});
