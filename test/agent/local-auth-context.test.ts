import { mkdir, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { detectLocalAuthContext, localAuthContextEnv } from '../../src/agent/local-auth-context.js';
import { CLAUDE_CODE_MESSAGING_SOCKET, CLAUDE_CODE_MESSAGING_TOKEN } from '../../src/agent/claude-auth-uds.js';
import { ClaudeCodeSdkProvider } from '../../src/agent/providers/claude-code-sdk.js';

describe('provider-neutral local auth context', () => {
  it('detects an environment-token provider without applying Claude rules', async () => {
    const context = await detectLocalAuthContext('codex-sdk', { OPENAI_API_KEY: 'test-key' });
    expect(context).toMatchObject({
      providerId: 'codex-sdk', method: 'env-token', source: 'env:OPENAI_API_KEY', authenticated: true, reusable: true,
    });
    expect(localAuthContextEnv('codex-sdk', { OPENAI_API_KEY: 'test-key' })).toEqual({ OPENAI_API_KEY: 'test-key' });
  });

  it('detects a provider credential file without reading or copying its contents', async () => {
    const home = `/tmp/imcodes-local-auth-${process.pid}`;
    await mkdir(`${home}/.codex`, { recursive: true, mode: 0o700 });
    await writeFile(`${home}/.codex/auth.json`, '{"access_token":"redacted-test-fixture"}', { mode: 0o600 });
    try {
      const context = await detectLocalAuthContext('codex-sdk', { HOME: home });
      expect(context).toMatchObject({ method: 'credential-file', authenticated: true, reusable: true, env: {} });
      expect(context.source).toBe(`${home}/.codex/auth.json`);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('detects Codex ChatGPT nested tokens and refresh_token fallback', async () => {
    const home = `/tmp/imcodes-local-auth-chatgpt-${process.pid}`;
    await mkdir(`${home}/.codex`, { recursive: true, mode: 0o700 });
    const path = `${home}/.codex/auth.json`;
    try {
      // 1. Nested tokens with active access_token
      const future = Math.floor(Date.now() / 1000) + 3600;
      const futureJwt = `a.${Buffer.from(JSON.stringify({ exp: future })).toString('base64url')}.c`;
      await writeFile(path, JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          access_token: futureJwt,
          refresh_token: 'valid-refresh-token',
        },
      }), { mode: 0o600 });
      let context = await detectLocalAuthContext('codex-sdk', { HOME: home });
      expect(context).toMatchObject({ method: 'credential-file', authenticated: true, reusable: true });

      // 2. Expired access_token with refresh_token fallback (auto-refreshable by Codex CLI)
      const expiredJwt = `a.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.c`;
      await writeFile(path, JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          access_token: expiredJwt,
          refresh_token: 'valid-refresh-token',
        },
      }), { mode: 0o600 });
      context = await detectLocalAuthContext('codex-sdk', { HOME: home });
      expect(context).toMatchObject({ method: 'credential-file', authenticated: true, reusable: true });

      // 3. OPENAI_API_KEY in auth.json
      await writeFile(path, JSON.stringify({
        auth_mode: 'api_key',
        OPENAI_API_KEY: 'sk-test-stored-key',
      }), { mode: 0o600 });
      context = await detectLocalAuthContext('codex-sdk', { HOME: home });
      expect(context).toMatchObject({ method: 'credential-file', authenticated: true, reusable: true });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('rejects malformed, tokenless and expired Codex credential files', async () => {
    const home = `/tmp/imcodes-local-auth-invalid-${process.pid}`;
    await mkdir(`${home}/.codex`, { recursive: true, mode: 0o700 });
    const path = `${home}/.codex/auth.json`;
    try {
      await writeFile(path, '{bad-json', { mode: 0o600 });
      await expect(detectLocalAuthContext('codex-sdk', { HOME: home })).resolves.toMatchObject({ authenticated: false, reusable: false });
      await writeFile(path, '{"profile":"no-token"}');
      await expect(detectLocalAuthContext('codex-sdk', { HOME: home })).resolves.toMatchObject({ authenticated: false, reusable: false });
      const expired = Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url');
      await writeFile(path, JSON.stringify({ access_token: `a.${expired}.c` }));
      await expect(detectLocalAuthContext('codex-sdk', { HOME: home })).resolves.toMatchObject({ authenticated: false, reusable: false });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('rejects unknown providers and does not cross-apply Claude UDS variables', async () => {
    const context = await detectLocalAuthContext('mystery-sdk', {
      [CLAUDE_CODE_MESSAGING_SOCKET]: 'uds:/tmp/cc-socks/other.sock',
      [CLAUDE_CODE_MESSAGING_TOKEN]: 'token',
      OPENAI_API_KEY: 'key',
    });
    expect(context).toMatchObject({ method: 'unsupported', authenticated: false, reusable: false });
    expect(localAuthContextEnv('mystery-sdk', process.env)).toEqual({});
  });

  it('rejects an unverifiable Claude auth candidate before query startup', async () => {
    const provider = new ClaudeCodeSdkProvider();
    await expect(provider.createSession({
      sessionKey: 'invalid-uds-session',
      cwd: '/tmp',
      env: {
        [CLAUDE_CODE_MESSAGING_SOCKET]: 'uds:/tmp/cc-socks/missing-auth.sock',
        [CLAUDE_CODE_MESSAGING_TOKEN]: 'token',
      },
    })).rejects.toThrow(/local auth unavailable|unavailable|handshake failed/i);
  });

  it('uses real provider-specific environment auth adapters and rejects unsupported methods', async () => {
    await expect(detectLocalAuthContext('gemini-sdk', { GEMINI_API_KEY: 'gemini-key' })).resolves.toMatchObject({ method: 'env-token', authenticated: true, reusable: true });
    await expect(detectLocalAuthContext('grok-sdk', { XAI_API_KEY: 'xai-key' })).resolves.toMatchObject({ method: 'env-token', authenticated: true, reusable: true });
    await expect(detectLocalAuthContext('copilot-sdk', { GITHUB_TOKEN: 'github-token' })).resolves.toMatchObject({ method: 'env-token', authenticated: true, reusable: true });
    await expect(detectLocalAuthContext('qwen', { QWEN_API_KEY: 'qwen-key' })).resolves.toMatchObject({ method: 'env-token', authenticated: true, reusable: true });
    await expect(detectLocalAuthContext('kimi-sdk', { KIMI_API_KEY: 'kimi-key' })).resolves.toMatchObject({ method: 'env-token', authenticated: true, reusable: true });
    await expect(detectLocalAuthContext('muse-code-sdk', { MUSE_API_KEY: 'muse-key' })).resolves.toMatchObject({ method: 'env-token', authenticated: true, reusable: true });
    await expect(detectLocalAuthContext('copilot-sdk', { ANTHROPIC_API_KEY: 'wrong-provider-key' })).resolves.toMatchObject({ method: 'unsupported', authenticated: false, reusable: false });
  });

  it('fails closed for Gemini/Grok credential files unless a non-expired JWT is verifiable', async () => {
    const home = `/tmp/imcodes-json-auth-${process.pid}`;
    await mkdir(`${home}/.gemini`, { recursive: true, mode: 0o700 });
    await mkdir(`${home}/.grok`, { recursive: true, mode: 0o700 });
    const geminiPath = `${home}/.gemini/oauth_creds.json`;
    const grokPath = `${home}/.grok/auth.json`;
    const jwt = (exp: number) => `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;
    try {
      await writeFile(geminiPath, '{bad-json', { mode: 0o600 });
      await writeFile(grokPath, JSON.stringify({ access_token: 'opaque-token' }), { mode: 0o600 });
      await expect(detectLocalAuthContext('gemini-sdk', { HOME: home })).resolves.toMatchObject({ authenticated: false, reusable: false });
      await expect(detectLocalAuthContext('grok-sdk', { HOME: home })).resolves.toMatchObject({ authenticated: false, reusable: false });
      await writeFile(geminiPath, JSON.stringify({ access_token: jwt(1) }));
      await expect(detectLocalAuthContext('gemini-sdk', { HOME: home })).resolves.toMatchObject({ authenticated: false, reusable: false });
      await writeFile(grokPath, JSON.stringify({ access_token: jwt(Math.floor(Date.now() / 1000) + 3600) }));
      await expect(detectLocalAuthContext('grok-sdk', { HOME: home })).resolves.toMatchObject({ method: 'credential-file', authenticated: true, reusable: true });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('returns explicit unsupported contexts for every registry provider without a verified adapter', async () => {
    const unsupported = ['openclaw', 'agy-sdk', 'qoder-sdk', 'cursor-headless', 'opencode-sdk', 'deepseek-harness', 'pi', 'hermes-acp', 'codebuddy-cn', 'codebuddy-international'];
    for (const providerId of unsupported) {
      await expect(detectLocalAuthContext(providerId, {})).resolves.toMatchObject({
        providerId, method: 'unsupported', authenticated: false, reusable: false,
      });
    }
  });

  it('caches the verified context at createSession and reuses its env projection', async () => {
    const provider = new ClaudeCodeSdkProvider();
    const context = {
      providerId: 'claude-code-sdk',
      method: 'uds' as const,
      source: 'uds:/tmp/cc-socks/verified.sock',
      authenticated: true,
      reusable: true,
      env: {
        CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/verified.sock',
        CLAUDE_CODE_MESSAGING_TOKEN: 'opaque-token',
      },
    };
    await provider.createSession({ sessionKey: 'verified-context', cwd: '/tmp', authContext: context });
    expect((provider as any).sessions.get('verified-context').localAuthContext).toBe(context);
  });
});
