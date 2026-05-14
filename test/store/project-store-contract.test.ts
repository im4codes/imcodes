import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const { projectStoreState } = vi.hoisted(() => ({
  projectStoreState: {
    home: '/tmp/imcodes-project-store-home',
  },
}));

vi.mock('node:os', () => ({
  homedir: () => projectStoreState.home,
}));

describe('project-store contracts', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-11T00:00:00.000Z'));
    rmSync(projectStoreState.home, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(projectStoreState.home, { recursive: true, force: true });
  });

  it('loads missing stores as empty and persists debounced project changes', async () => {
    const storePath = join(projectStoreState.home, '.imcodes', 'projects.json');
    const projectStore = await import('../../src/store/project-store.js');

    await expect(projectStore.loadProjectStore()).resolves.toEqual({ projects: {} });
    expect(existsSync(join(projectStoreState.home, '.imcodes'))).toBe(true);

    projectStore.upsertProject({
      name: 'codedeck',
      dir: '/repo',
      coderAgent: 'codex',
      auditorAgent: 'claude-code',
      maxDiscussionRounds: 3,
      autoMerge: false,
      tracker: {
        type: 'github',
        tokenEnv: 'GITHUB_TOKEN',
        repo: 'im4codes/imcodes',
        baseBranch: 'main',
      },
      issueFilters: { labels: ['bug'], assignedToMe: true },
    });

    expect(projectStore.getProject('codedeck')).toMatchObject({
      name: 'codedeck',
      createdAt: Date.parse('2026-05-11T00:00:00.000Z'),
      updatedAt: Date.parse('2026-05-11T00:00:00.000Z'),
    });
    expect(existsSync(storePath)).toBe(false);

    await vi.runOnlyPendingTimersAsync();
    await projectStore.flushProjectStore();
    expect(JSON.parse(readFileSync(storePath, 'utf8'))).toMatchObject({
      projects: {
        codedeck: {
          dir: '/repo',
          tracker: { repo: 'im4codes/imcodes' },
        },
      },
    });
  });

  it('recovers existing stores, updates records, removes records, and flushes synchronously', async () => {
    const projectStore = await import('../../src/store/project-store.js');
    const firstCreatedAt = Date.parse('2026-05-10T00:00:00.000Z');

    await projectStore.loadProjectStore();
    projectStore.upsertProject({
      name: 'codedeck',
      dir: '/repo',
      coderAgent: 'codex',
      auditorAgent: 'claude-code',
      maxDiscussionRounds: 3,
      autoMerge: false,
      createdAt: firstCreatedAt,
    });
    await projectStore.flushProjectStore();

    vi.setSystemTime(new Date('2026-05-11T01:00:00.000Z'));
    projectStore.updateProject('codedeck', { autoMerge: true, maxDiscussionRounds: 5 });
    projectStore.updateProject('missing', { autoMerge: true });
    expect(projectStore.listProjects()).toHaveLength(1);
    expect(projectStore.getProject('codedeck')).toMatchObject({
      createdAt: firstCreatedAt,
      updatedAt: Date.parse('2026-05-11T01:00:00.000Z'),
      autoMerge: true,
      maxDiscussionRounds: 5,
    });

    projectStore.removeProject('codedeck');
    expect(projectStore.listProjects()).toEqual([]);
    await projectStore.flushProjectStore();

    vi.resetModules();
    const reloaded = await import('../../src/store/project-store.js');
    await expect(reloaded.loadProjectStore()).resolves.toEqual({ projects: {} });
  });
});
