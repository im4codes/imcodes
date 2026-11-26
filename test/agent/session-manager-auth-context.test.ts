import { describe, expect, it } from 'vitest';
import { resolveLaunchAuthContext } from '../../src/agent/session-manager.js';

describe('session-manager local auth launch context', () => {
  it('passes explicit unsupported context for known providers without an adapter', async () => {
    await expect(resolveLaunchAuthContext('agy-sdk', {})).resolves.toMatchObject({
      providerId: 'agy-sdk', method: 'unsupported', authenticated: false, reusable: false,
    });
  });

  it('keeps unknown provider IDs distinct instead of fabricating context', async () => {
    await expect(resolveLaunchAuthContext('unknown-provider', {})).resolves.toBeUndefined();
  });

  it('resolves launch context for codex-sdk when auth is configured', async () => {
    await expect(resolveLaunchAuthContext('codex-sdk', { OPENAI_API_KEY: 'test-key' })).resolves.toMatchObject({
      providerId: 'codex-sdk',
      authenticated: true,
      reusable: true,
    });
  });

  it('resolves launch context for codex-sdk with host real auth.json if present', async () => {
    const ctx = await resolveLaunchAuthContext('codex-sdk', process.env);
    if (ctx) {
      expect(ctx.authenticated).toBe(true);
      expect(ctx.reusable).toBe(true);
    }
  });
});
