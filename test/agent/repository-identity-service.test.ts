import { describe, expect, it } from 'vitest';
import { GitOriginRepositoryIdentityService } from '../../src/agent/repository-identity-service.js';

describe('GitOriginRepositoryIdentityService', () => {
  const service = new GitOriginRepositoryIdentityService();

  it('normalizes SSH and HTTPS origins to the same canonical key', () => {
    const httpsIdentity = service.resolve({ originUrl: 'https://github.com/acme/repo.git' });
    const sshIdentity = service.resolve({ originUrl: 'git@github.com:acme/repo.git' });

    expect(httpsIdentity).toMatchObject({
      kind: 'git-origin',
      key: 'github.com/acme/repo',
    });
    expect(sshIdentity).toMatchObject({
      kind: 'git-origin',
      key: 'github.com/acme/repo',
    });
  });

  it('normalizes self-hosted GitLab ssh:// remotes with SSH ports and mixed-case paths', () => {
    const identity = service.resolve({
      originUrl: 'ssh://git@172.16.253.211:2224/Hermit/ai_purchase2.git',
    });

    expect(identity).toMatchObject({
      kind: 'git-origin',
      key: '172.16.253.211/hermit/ai_purchase2',
      host: '172.16.253.211',
      owner: 'hermit',
      repo: 'ai_purchase2',
    });
  });

  it('falls back to a stable local identity when origin is missing', () => {
    const a = service.resolve({ cwd: '/tmp/project-a' });
    const b = service.resolve({ cwd: '/tmp/project-a' });
    const c = service.resolve({ cwd: '/tmp/project-b' });

    expect(a.kind).toBe('local-fallback');
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(c.key);
  });

  it('does not preserve continuity automatically across host changes', () => {
    const github = service.resolve({ originUrl: 'https://github.com/acme/repo.git' });
    const gitlab = service.resolve({ originUrl: 'https://gitlab.com/acme/repo.git' });

    expect(github.key).not.toBe(gitlab.key);
  });

  it('builds raw-origin aliases only for canonical git origins', () => {
    const alias = service.buildAlias('git@github.com:acme/repo.git');
    expect(alias).toEqual({
      aliasKey: 'git@github.com:acme/repo.git',
      canonicalKey: 'github.com/acme/repo',
      reason: 'ssh-https-equivalent',
    });
  });

  it('builds explicit migration aliases for host changes only when repo identity still matches', () => {
    const alias = service.buildExplicitMigrationAlias(
      'github.com/acme/repo',
      'https://gitlab.com/acme/repo.git',
    );

    expect(alias).toEqual({
      aliasKey: 'https://gitlab.com/acme/repo.git',
      canonicalKey: 'github.com/acme/repo',
      reason: 'explicit-migration',
    });
  });

  it('does not build aliases automatically for unrelated repositories', () => {
    expect(
      service.buildExplicitMigrationAlias('github.com/acme/repo', 'https://github.com/acme/other.git'),
    ).toBeNull();
  });
});
