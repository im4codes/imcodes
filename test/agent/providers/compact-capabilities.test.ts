import { describe, expect, it } from 'vitest';

import { CursorHeadlessProvider } from '../../../src/agent/providers/cursor-headless.js';
import { GeminiSdkProvider } from '../../../src/agent/providers/gemini-sdk.js';
import { OpenClawProvider } from '../../../src/agent/providers/openclaw.js';
import { QwenProvider } from '../../../src/agent/providers/qwen.js';

describe('provider compact capabilities', () => {
  it('marks Qwen as verified via its /compress slash command', () => {
    const provider = new QwenProvider();

    expect(provider.capabilities.compact).toMatchObject({
      execution: 'slash-command',
      providerCommand: '/compress',
      verified: true,
      completion: 'command-result',
      cancellation: 'provider-cancel',
    });
  });

  it('keeps Gemini ACP unsupported because its ACP command registry has no compress/compact command', () => {
    const provider = new GeminiSdkProvider();

    expect(provider.capabilities.compact).toMatchObject({
      execution: 'unsupported',
      verified: true,
      completion: 'none',
      cancellation: 'none',
    });
    expect(provider.capabilities.compact?.reason).toMatch(/--acp command registry/i);
  });

  it('keeps Cursor headless and OpenClaw unsupported with verified reasons', () => {
    expect(new CursorHeadlessProvider().capabilities.compact).toMatchObject({
      execution: 'unsupported',
      verified: true,
    });
    expect(new OpenClawProvider().capabilities.compact).toMatchObject({
      execution: 'unsupported',
      verified: true,
    });
  });
});
