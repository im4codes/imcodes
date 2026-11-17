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

  it('preserves scoped session identity and mise runtime vars without widening the env', () => {
    const env = buildClaudeAgentEnv({
      IMCODES_SESSION: 'deck_test_claude',
      IMCODES_SESSION_LABEL: 'Claude test',
      IMCODES_DAEMON_SESSION_NAME: 'deck_test_claude',
      MISE_PYTHON_VERSION: '3.12',
      OPENAI_API_KEY: 'must-not-cross-provider',
      RANDOM_SECRET: 'must-not-leak',
    });

    expect(env).toMatchObject({
      IMCODES_SESSION: 'deck_test_claude',
      IMCODES_SESSION_LABEL: 'Claude test',
      IMCODES_DAEMON_SESSION_NAME: 'deck_test_claude',
      MISE_PYTHON_VERSION: '3.12',
    });
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('RANDOM_SECRET');
  });

  it('preserves CLAUDE_CODE_OAUTH_TOKEN from explicit route env and CLAUDE_CONFIG_DIR across host/session config', () => {
    const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = '/tmp/host-claude-config';
    try {
      const fromHost = buildClaudeAgentEnv({
        CLAUDE_CODE_OAUTH_TOKEN: 'explicit-oauth-fixture',
        OPENAI_API_KEY: 'must-not-cross-provider',
      });
      expect(fromHost.CLAUDE_CODE_OAUTH_TOKEN).toBe('explicit-oauth-fixture');
      expect(fromHost.CLAUDE_CONFIG_DIR).toBe('/tmp/host-claude-config');
      expect(fromHost).not.toHaveProperty('OPENAI_API_KEY');

      const overridden = buildClaudeAgentEnv({
        CLAUDE_CONFIG_DIR: '/tmp/session-claude-config',
      });
      expect(overridden.CLAUDE_CONFIG_DIR).toBe('/tmp/session-claude-config');
    } finally {
      if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    }
  });
});
