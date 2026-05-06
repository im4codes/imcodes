import { describe, expect, it } from 'vitest';
import {
  contextBindingVisibleToRuntime,
  createContextNamespaceBinding,
  normalizeCanonicalRepoId,
  sameCanonicalProject,
} from '../../shared/memory-namespace.js';

describe('project remote identity sync', () => {
  it('normalizes common git remote aliases into one canonical project id', () => {
    expect(normalizeCanonicalRepoId('git@github.com:Acme/Repo.git')).toBe('github.com/acme/repo');
    expect(normalizeCanonicalRepoId('https://github.com/acme/repo')).toBe('github.com/acme/repo');
    expect(normalizeCanonicalRepoId('github.com/acme/repo.git')).toBe('github.com/acme/repo');
    expect(normalizeCanonicalRepoId('ssh://git@172.16.253.211:2224/Hermit/ai_purchase2.git')).toBe('172.16.253.211/hermit/ai_purchase2');
    expect(normalizeCanonicalRepoId('https://git.corp.example.com:8443/Team/Internal.git')).toBe('git.corp.example.com:8443/team/internal');
    expect(sameCanonicalProject(
      { projectId: 'git@github.com:Acme/Repo.git' },
      { projectId: 'https://github.com/acme/repo' },
    )).toBe(true);
    expect(sameCanonicalProject(
      { projectId: 'ssh://git@172.16.253.211:2224/Hermit/ai_purchase2.git' },
      { projectId: '172.16.253.211/hermit/ai_purchase2' },
    )).toBe(true);
  });

  it('keeps same-user same-remote project memory visible across devices without local path identity', () => {
    const laptop = createContextNamespaceBinding({
      scope: 'personal',
      userId: 'user-1',
      canonicalRepoId: 'git@github.com:Acme/Repo.git',
      name: 'project-memory',
    });

    expect(contextBindingVisibleToRuntime(laptop, {
      userId: 'user-1',
      canonicalRepoId: 'https://github.com/acme/repo',
    })).toBe(true);
    expect(contextBindingVisibleToRuntime(laptop, {
      userId: 'user-2',
      canonicalRepoId: 'https://github.com/acme/repo',
    })).toBe(false);
  });

  it('does not use local paths or machine-specific ids as cross-device project identity', () => {
    const localFallback = createContextNamespaceBinding({
      scope: 'personal',
      userId: 'user-1',
      projectId: '/Users/k/work/repo',
      name: 'local-fallback',
    });

    expect(contextBindingVisibleToRuntime(localFallback, {
      userId: 'user-1',
      projectId: '/home/k/work/repo',
    })).toBe(false);
    expect(contextBindingVisibleToRuntime(localFallback, {
      userId: 'user-1',
      projectId: '/Users/k/work/repo',
    })).toBe(true);
  });
});
