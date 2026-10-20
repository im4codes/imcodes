import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import {
  clearSessionIdentityProfile,
  getEffectiveSessionIdentityProfiles,
  getSessionIdentityProfile,
  listSessionIdentityProfiles,
  setSessionIdentityProfile,
} from '../../src/daemon/session-identity-mcp-client.js';

const home = join(process.cwd(), '.tmp-identity-client');
const endpoint = { workerUrl: 'https://im.example.test/', serverId: 'srv-1', token: 'secret-token' };

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

/**
 * Owner rule (tsk_cd_identity_daemon_storage): the daemon must never call the
 * server over HTTP for identity -- get/set/clear/list/effective all read and
 * write session-identity-local-store.ts directly. Every test below passes a
 * `fetchImpl` spy and asserts it is NEVER called, which is the causal proof:
 * on the pre-fix code this same call would have made 1-3 real fetch() calls.
 */
describe('session identity local-first client (never HTTP)', () => {
  it('sets and reads back a profile purely from local disk, never calling fetch', async () => {
    vi.stubEnv('IMCODES_HOME', home);
    const fetchImpl = vi.fn();
    const written = await setSessionIdentityProfile({
      scope: 'project', scopeKey: 'repo-1', content: 'project identity',
    }, { endpoint, fetchImpl });
    expect(written).toMatchObject({ status: 'ok', profile: { content: 'project identity', revision: 1 } });
    const read = await getSessionIdentityProfile('project', 'repo-1', { endpoint, fetchImpl });
    expect(read).toMatchObject({ status: 'ok', profile: { content: 'project identity' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lists every locally-stored profile across scopes, never calling fetch', async () => {
    vi.stubEnv('IMCODES_HOME', home);
    const fetchImpl = vi.fn();
    await setSessionIdentityProfile({ scope: 'user', scopeKey: '', content: 'global identity' }, { endpoint, fetchImpl });
    await setSessionIdentityProfile({ scope: 'session', scopeKey: 'srv-1:deck_proj_cc1', content: 'session identity' }, { endpoint, fetchImpl });
    const result = await listSessionIdentityProfiles({ endpoint, fetchImpl });
    expect(result).toMatchObject({
      status: 'ok', serverId: 'srv-1', truncated: false,
      profiles: expect.arrayContaining([
        expect.objectContaining({ scope: 'user', content: 'global identity' }),
        expect.objectContaining({ scope: 'session', content: 'session identity' }),
      ]),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('clears a locally-stored profile, never calling fetch', async () => {
    vi.stubEnv('IMCODES_HOME', home);
    const fetchImpl = vi.fn();
    await setSessionIdentityProfile({ scope: 'project', scopeKey: 'repo-1', content: 'x' }, { endpoint, fetchImpl });
    await expect(clearSessionIdentityProfile('project', 'repo-1', 7, { endpoint, fetchImpl }))
      .resolves.toEqual({ status: 'ok', deleted: true });
    await expect(getSessionIdentityProfile('project', 'repo-1', { endpoint, fetchImpl }))
      .resolves.toEqual({ status: 'ok', profile: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refreshes one session from only its three local scope reads, never calling fetch', async () => {
    vi.stubEnv('IMCODES_HOME', home);
    const fetchImpl = vi.fn();
    await setSessionIdentityProfile({ scope: 'user', scopeKey: '', content: 'global' }, { endpoint, fetchImpl });
    await setSessionIdentityProfile({ scope: 'session', scopeKey: 'srv-1:deck_proj_brain', content: 'session' }, { endpoint, fetchImpl });
    const result = await getEffectiveSessionIdentityProfiles({
      projectKey: 'repo-1', sessionName: 'deck_proj_brain',
    }, { endpoint, fetchImpl });
    expect(result).toMatchObject({
      status: 'ok', serverId: 'srv-1',
      profiles: expect.arrayContaining([
        expect.objectContaining({ scope: 'user', content: 'global' }),
        expect.objectContaining({ scope: 'session', content: 'session' }),
      ]),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a missing local profile reads back null instead of erroring, never calling fetch', async () => {
    vi.stubEnv('IMCODES_HOME', home);
    const fetchImpl = vi.fn();
    await expect(getSessionIdentityProfile('project', 'never-written', { endpoint, fetchImpl }))
      .resolves.toEqual({ status: 'ok', profile: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
