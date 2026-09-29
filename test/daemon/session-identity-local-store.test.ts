import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  getLocalSessionIdentityProfile,
  listLocalSessionIdentityProfiles,
  localSessionIdentityStorePath,
  putLocalSessionIdentityProfile,
  removeLocalSessionIdentityProfile,
} from '../../src/daemon/session-identity-local-store.js';

const home = join(process.cwd(), '.tmp-identity-local-store');

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('daemon-local session identity store', () => {
  it('writes content only below the configured scoped home and reopens atomically', async () => {
    vi.stubEnv('IMCODES_HOME', home);
    const saved = await putLocalSessionIdentityProfile({
      scope: 'user', scopeKey: '', content: '  local identity  ', source: 'web',
    });
    expect(saved.content).toBe('local identity');
    expect(saved.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(localSessionIdentityStorePath()).toBe(join(home, 'session-identities.json'));
    expect(await getLocalSessionIdentityProfile('user', '')).toMatchObject({ content: 'local identity', revision: 1 });
    expect(JSON.parse(await readFile(localSessionIdentityStorePath(), 'utf8')).profiles['user\0'].content)
      .toBe('local identity');
  });

  it('preserves independent scopes and removes only the requested key', async () => {
    vi.stubEnv('IMCODES_HOME', home);
    await putLocalSessionIdentityProfile({ scope: 'user', scopeKey: '', content: 'user', source: 'mcp' });
    await putLocalSessionIdentityProfile({ scope: 'project', scopeKey: 'repo', content: 'project', source: 'mcp' });
    expect((await listLocalSessionIdentityProfiles()).map((profile) => profile.scope)).toEqual(['user', 'project']);
    await expect(removeLocalSessionIdentityProfile('user', '')).resolves.toBe(true);
    expect(await getLocalSessionIdentityProfile('project', 'repo')).toMatchObject({ content: 'project' });
    expect(await getLocalSessionIdentityProfile('user', '')).toBeNull();
  });
});
