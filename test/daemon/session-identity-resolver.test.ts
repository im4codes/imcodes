import { describe, expect, it, vi } from 'vitest';
import {
  profilesForSession,
  resolveEffectiveIdentities,
  resolveEffectiveIdentityPrompt,
} from '../../src/daemon/session-identity-resolver.js';
import { identityPromptHash } from '../../src/util/identity-prompt-hash.js';
import {
  renderSessionIdentityProfiles,
  type SessionIdentityProfile,
} from '../../shared/session-identity.js';
import logger from '../../src/util/logger.js';

function profile(scope: SessionIdentityProfile['scope'], scopeKey: string, content: string): SessionIdentityProfile {
  return { scope, scopeKey, content, contentHash: `h:${content.length}:${content.slice(0, 8)}`, revision: 1, updatedAt: 1, source: 'mcp' };
}
const SERVER = 'srv-9';
const PROFILES = [
  profile('user', '', `用户全局契约 ${'中'.repeat(50_000)} 😀 é`),
  profile('project', 'repo-1', 'project rules'),
  profile('project', 'repo-2', 'other project rules'),
  profile('session', `${SERVER}:deck_proj_brain`, 'main session rules'),
  profile('session', `${SERVER}:deck_sub_x`, 'sub session rules'),
];
const deps = { listProfiles: async () => PROFILES, boundServerId: async () => SERVER };

describe('the single derivation of a session identity prompt', () => {
  it('renders exactly the profiles that apply: user + the session\'s project + the session itself, in scope order', async () => {
    const prompt = await resolveEffectiveIdentityPrompt({ name: 'deck_proj_brain', projectName: 'proj', contextNamespace: { projectId: 'repo-1' } }, deps);
    expect(prompt).toBe(renderSessionIdentityProfiles([PROFILES[0]!, PROFILES[1]!, PROFILES[3]!]));
    expect(prompt).not.toContain('other project rules');
    expect(prompt).not.toContain('sub session rules');
  });

  it('a sub-session resolves with the same rules as a main session (its own SESSION profile, its parent project\'s PROJECT profile)', async () => {
    const sub = await resolveEffectiveIdentityPrompt({ name: 'deck_sub_x', projectName: 'proj', contextNamespace: { projectId: 'repo-1' } }, deps);
    expect(sub).toBe(renderSessionIdentityProfiles([PROFILES[0]!, PROFILES[1]!, PROFILES[4]!]));
  });

  it('falls back to the project NAME as the PROJECT scope key when no canonical project id is known', () => {
    const applicable = profilesForSession([profile('project', 'proj', 'by name'), profile('project', 'repo-1', 'by id')], { name: 'deck_proj_brain', projectName: 'proj' }, SERVER);
    expect(applicable.map((entry) => entry.content)).toEqual(['by name']);
  });

  it('no applicable profile means no identity, and the same profiles are rendered once for many sessions', async () => {
    const names = Array.from({ length: 120 }, (_, index) => ({ name: `deck_many_w${index}`, projectName: 'proj', contextNamespace: { projectId: 'repo-1' } }));
    const resolved = await resolveEffectiveIdentities([...names, { name: 'deck_nobody', projectName: 'x', contextNamespace: { projectId: 'none' } }], {
      listProfiles: async () => [PROFILES[0]!, PROFILES[1]!],
      boundServerId: async () => SERVER,
    });
    const first = resolved.get('deck_many_w0')!;
    expect(first.hash).toBe(identityPromptHash(first.prompt));
    for (const { name } of names) expect(resolved.get(name)!.prompt, name).toBe(first.prompt); // one shared rendering
    expect(resolved.get('deck_many_w5')).toBe(first); // literally the same object: rendered once, not 120 times
    expect(resolved.get('deck_nobody')!.prompt).toContain('用户全局契约'); // the user scope applies to every session
    expect(resolved.get('deck_nobody')!.prompt).not.toContain('project rules');
  });

  it('with no profile at all there is no prompt and no hash', async () => {
    const resolved = await resolveEffectiveIdentities([{ name: 'deck_a_brain', projectName: 'a' }], { listProfiles: async () => [], boundServerId: async () => SERVER });
    expect(resolved.get('deck_a_brain')).toEqual({ prompt: undefined, hash: undefined });
  });

  it('an unavailable identity store: a launch proceeds WITHOUT an identity (no stale copy), says so without the content, and counts it', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const prompt = await resolveEffectiveIdentityPrompt({ name: 'deck_proj_brain', projectName: 'proj' }, {
      listProfiles: async () => { throw Object.assign(new Error(`cannot read ${PROFILES[0]!.content}`), { name: 'EIO' }); },
      boundServerId: async () => SERVER,
    });
    expect(prompt).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).toContain('deck_proj_brain');
    expect(logged).not.toContain('用户全局契约'); // names and the error class only, never identity text
    warn.mockRestore();
  });

  it('the batch resolver THROWS on an unreadable store (the sync must not apply "no identity")', async () => {
    await expect(resolveEffectiveIdentities([{ name: 'deck_a_brain', projectName: 'a' }], {
      listProfiles: async () => { throw new Error('unreadable'); },
      boundServerId: async () => SERVER,
    })).rejects.toThrow('unreadable');
  });
});
