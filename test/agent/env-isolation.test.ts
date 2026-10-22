import { describe, expect, it } from 'vitest';
import { buildClaudeAgentEnv, getAgentEnvVars } from '../../src/agent/env-isolation.js';

describe('Claude SDK environment isolation', () => {
  it('passes explicit Claude auth/model vars without leaking other provider credentials', () => {
    const env = buildClaudeAgentEnv({
      ANTHROPIC_API_KEY: 'explicit-key',
      ANTHROPIC_AUTH_TOKEN: 'explicit-token',
      ANTHROPIC_BASE_URL: 'https://example.invalid/anthropic',
      ANTHROPIC_MODEL: 'claude-test',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-test',
      OPENAI_API_KEY: 'must-not-cross-provider',
      RANDOM_SECRET: 'must-not-leak',
    });

    expect(env).toMatchObject({
      ANTHROPIC_API_KEY: 'explicit-key',
      ANTHROPIC_AUTH_TOKEN: 'explicit-token',
      ANTHROPIC_BASE_URL: 'https://example.invalid/anthropic',
      ANTHROPIC_MODEL: 'claude-test',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-test',
    });
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('RANDOM_SECRET');
  });

  it('keeps empty explicit values and unsupported provider keys absent', () => {
    const env = buildClaudeAgentEnv({
      ANTHROPIC_API_KEY: '   ',
      OPENAI_BASE_URL: 'https://openai.invalid',
      GEMINI_API_KEY: 'gemini-secret',
    });

    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('OPENAI_BASE_URL');
    expect(env).not.toHaveProperty('GEMINI_API_KEY');
    expect(getAgentEnvVars('claude-code')).toContain('ANTHROPIC_API_KEY');
  });
});
