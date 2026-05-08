import { describe, expect, it } from 'vitest';
import {
  bindSessionTreeContext,
  contextBindingVisibleToRuntime,
  createContextNamespaceBinding,
  isSessionTreeBoundContext,
  sameRootSessionTree,
} from '../../shared/memory-namespace.js';

describe('session tree context binding', () => {
  it('shares project/session context inside the same root without adding a session_tree scope', () => {
    const main = bindSessionTreeContext({
      scope: 'personal',
      userId: 'user-1',
      canonicalRepoId: 'git@github.com:Acme/Repo.git',
      name: 'session-context',
    }, 'root-1', 'main-session');
    const sub = bindSessionTreeContext({
      scope: 'personal',
      userId: 'user-1',
      canonicalRepoId: 'https://github.com/acme/repo',
      name: 'session-context',
    }, 'root-1', 'sub-session');

    expect(main.scope).toBe('personal');
    expect(sub.scope).toBe('personal');
    expect(main.scope).not.toBe('session_tree');
    expect(sameRootSessionTree(main, sub)).toBe(true);
    expect(contextBindingVisibleToRuntime(main, {
      userId: 'user-1',
      canonicalRepoId: 'https://github.com/acme/repo.git',
      rootSessionId: 'root-1',
      sessionId: 'sub-session',
    })).toBe(true);
  });

  it('does not leak tree-bound context to another root even when canonical project matches', () => {
    const treeBound = bindSessionTreeContext({
      scope: 'personal',
      userId: 'user-1',
      canonicalRepoId: 'github.com/acme/repo',
      name: 'tree-only',
    }, 'root-1', 'main-session');

    expect(isSessionTreeBoundContext(treeBound)).toBe(true);
    expect(contextBindingVisibleToRuntime(treeBound, {
      userId: 'user-1',
      canonicalRepoId: 'git@github.com:acme/repo.git',
      rootSessionId: 'root-2',
      sessionId: 'other-session',
    })).toBe(false);
  });

  it('allows non-tree project-bound memory across devices by canonical remote identity', () => {
    const projectBound = createContextNamespaceBinding({
      scope: 'personal',
      userId: 'user-1',
      canonicalRepoId: 'git@github.com:Acme/Repo.git',
      name: 'project-memory',
    });

    expect(isSessionTreeBoundContext(projectBound)).toBe(false);
    expect(contextBindingVisibleToRuntime(projectBound, {
      userId: 'user-1',
      canonicalRepoId: 'https://github.com/acme/repo',
      rootSessionId: 'different-root',
    })).toBe(true);
    expect(contextBindingVisibleToRuntime(projectBound, {
      userId: 'user-1',
      canonicalRepoId: 'github.com/acme/other',
    })).toBe(false);
  });
});
