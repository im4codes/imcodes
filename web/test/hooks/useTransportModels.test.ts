/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { supportsDynamicTransportModels } from '../../src/hooks/useTransportModels.js';
import { CODEBUDDY_PROVIDER_IDS } from '@shared/codebuddy.js';

/**
 * `supportsDynamicTransportModels` is the root model-selection registry for the
 * web app: every picker (new session, sub-session, session controls) gates its
 * model UI on it. An agent missing here has no reachable model entry point even
 * when the daemon fully implements `/model` and `listModels()` for it.
 */
describe('supportsDynamicTransportModels', () => {
  it('accepts every transport agent whose daemon provider answers transport.list_models', () => {
    const supported = [
      'claude-code-sdk',
      'copilot-sdk',
      'cursor-headless',
      'codex-sdk',
      'opencode-sdk',
      'gemini-sdk',
      'grok-sdk',
      'kimi-sdk',
      'deepseek-harness',
      'pi',
      'qwen',
      CODEBUDDY_PROVIDER_IDS.CHINA,
      CODEBUDDY_PROVIDER_IDS.INTERNATIONAL,
    ];
    for (const agentType of supported) {
      expect(supportsDynamicTransportModels(agentType), agentType).toBe(true);
    }
  });

  it('treats DSH and Pi like the other empty-catalogue providers', () => {
    // DSH/Pi resolve third-party provider routes from the selected preset,
    // so its catalogue is always empty — the same free-text case as Kimi/Grok.
    for (const agentType of ['deepseek-harness', 'pi', 'kimi-sdk', 'grok-sdk', 'cursor-headless']) {
      expect(supportsDynamicTransportModels(agentType), agentType).toBe(true);
    }
  });

  it('rejects agents with no daemon model plumbing', () => {
    const unsupported = ['claude-code', 'codex', 'opencode', 'gemini', 'shell', 'script', 'openclaw', 'qoder-sdk', '', undefined, null];
    for (const agentType of unsupported) {
      expect(supportsDynamicTransportModels(agentType), String(agentType)).toBe(false);
    }
  });
});
