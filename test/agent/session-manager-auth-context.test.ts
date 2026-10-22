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
});
