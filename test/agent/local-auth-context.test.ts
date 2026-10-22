import { mkdir, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { detectLocalAuthContext, localAuthContextEnv } from '../../src/agent/local-auth-context.js';
import { CLAUDE_CODE_MESSAGING_SOCKET, CLAUDE_CODE_MESSAGING_TOKEN } from '../../src/agent/claude-auth-uds.js';

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

  it('rejects unknown providers and does not cross-apply Claude UDS variables', async () => {
    const context = await detectLocalAuthContext('mystery-sdk', {
      [CLAUDE_CODE_MESSAGING_SOCKET]: 'uds:/tmp/cc-socks/other.sock',
      [CLAUDE_CODE_MESSAGING_TOKEN]: 'token',
      OPENAI_API_KEY: 'key',
    });
    expect(context).toMatchObject({ method: 'unsupported', authenticated: false, reusable: false });
    expect(localAuthContextEnv('mystery-sdk', process.env)).toEqual({});
  });
});
