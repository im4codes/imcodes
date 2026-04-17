import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureSharedContextRuntime } from '../../src/context/shared-context-runtime.js';
import { writeProcessedProjection } from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

const detectRepoMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/repo/detector.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/repo/detector.js')>();
  return {
    ...actual,
    detectRepo: detectRepoMock,
  };
});

import { buildTransportStartupMemory, resolveTransportContextBootstrap } from '../../src/agent/runtime-context-bootstrap.js';

describe('resolveTransportContextBootstrap', () => {
  let tempDir: string;

  beforeEach(() => {
    detectRepoMock.mockReset();
    configureSharedContextRuntime(null);
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('runtime-context-bootstrap');
  });

  afterEach(async () => {
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('uses canonical git-origin identity from projectDir when no explicit namespace is configured', async () => {
    detectRepoMock.mockResolvedValue({
      info: {
        remoteUrl: 'git@github.com:acme/repo.git',
      },
    });

    const result = await resolveTransportContextBootstrap({
      projectDir: '/tmp/project',
      transportConfig: {},
    });

    expect(result).toEqual({
      namespace: {
        scope: 'personal',
        projectId: 'github.com/acme/repo',
      },
      diagnostics: ['namespace:git-origin'],
      localProcessedFreshness: 'missing',
    });
  });

  it('uses explicit shared namespace from transportConfig when present', async () => {
    const result = await resolveTransportContextBootstrap({
      projectDir: '/tmp/project',
      transportConfig: {
        sharedContextNamespace: {
          scope: 'project_shared',
          projectId: 'github.com/acme/repo',
          enterpriseId: 'ent-1',
          workspaceId: 'ws-1',
        },
      },
    });

    expect(result).toEqual({
      namespace: {
        scope: 'project_shared',
        projectId: 'github.com/acme/repo',
        enterpriseId: 'ent-1',
        workspaceId: 'ws-1',
      },
      diagnostics: ['namespace:explicit'],
      localProcessedFreshness: 'missing',
    });
    expect(detectRepoMock).not.toHaveBeenCalled();
  });

  it('falls back deterministically when no repo remote is available', async () => {
    detectRepoMock.mockResolvedValue({ info: null });

    const result = await resolveTransportContextBootstrap({
      projectDir: '/tmp/project',
      transportConfig: {},
    });

    expect(result.namespace.scope).toBe('personal');
    expect(result.namespace.projectId).toMatch(/^local\//);
    expect(result.diagnostics).toEqual(['namespace:local-fallback']);
    expect(result.localProcessedFreshness).toBe('missing');
    expect(result.startupMemory).toBeUndefined();
  });

  it('promotes to a shared namespace from server control-plane resolution when runtime credentials are configured', async () => {
    detectRepoMock.mockResolvedValue({
      info: {
        remoteUrl: 'https://github.com/acme/repo.git',
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        namespace: {
          scope: 'project_shared',
          projectId: 'github.com/acme/repo',
          enterpriseId: 'ent-1',
          workspaceId: 'ws-1',
        },
        canonicalRepoId: 'github.com/acme/repo',
        visibilityState: 'active',
        remoteProcessedFreshness: 'fresh',
        retryExhausted: true,
        diagnostics: ['visibility:active'],
      }),
    })));
    configureSharedContextRuntime({
      workerUrl: 'http://worker.test',
      serverId: 'srv-1',
      token: 'daemon-token',
    });

    const result = await resolveTransportContextBootstrap({
      projectDir: '/tmp/project',
      transportConfig: {},
    });

    expect(result).toEqual({
      namespace: {
        scope: 'project_shared',
        projectId: 'github.com/acme/repo',
        enterpriseId: 'ent-1',
        workspaceId: 'ws-1',
      },
      diagnostics: ['namespace:server-control-plane', 'visibility:active'],
      remoteProcessedFreshness: 'fresh',
      localProcessedFreshness: 'missing',
      retryExhausted: true,
    });
  });

  it('keeps personal fallback remote freshness when server control-plane reports unenrolled personal continuity', async () => {
    detectRepoMock.mockResolvedValue({
      info: {
        remoteUrl: 'https://github.com/acme/repo.git',
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        namespace: null,
        canonicalRepoId: 'github.com/acme/repo',
        visibilityState: 'unenrolled',
        remoteProcessedFreshness: 'fresh',
        retryExhausted: true,
        diagnostics: ['server-no-enterprise', 'remote-processed:fresh', 'remote-source:personal'],
      }),
    })));
    configureSharedContextRuntime({
      workerUrl: 'http://worker.test',
      serverId: 'srv-1',
      token: 'daemon-token',
    });

    const result = await resolveTransportContextBootstrap({
      projectDir: '/tmp/project',
      transportConfig: {},
    });

    expect(result).toEqual({
      namespace: {
        scope: 'personal',
        projectId: 'github.com/acme/repo',
      },
      diagnostics: [
        'namespace:server-personal-fallback',
        'server-no-enterprise',
        'remote-processed:fresh',
        'remote-source:personal',
      ],
      remoteProcessedFreshness: 'fresh',
      localProcessedFreshness: 'missing',
      retryExhausted: true,
    });
  });

  it('keeps remote personal freshness when the server resolves no shared enrollment', async () => {
    detectRepoMock.mockResolvedValue({
      info: {
        remoteUrl: 'https://github.com/acme/repo.git',
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        namespace: null,
        canonicalRepoId: 'github.com/acme/repo',
        visibilityState: 'unenrolled',
        remoteProcessedFreshness: 'fresh',
        retryExhausted: true,
        diagnostics: ['server-no-enterprise', 'remote-source:personal'],
      }),
    })));
    configureSharedContextRuntime({
      workerUrl: 'http://worker.test',
      serverId: 'srv-1',
      token: 'daemon-token',
    });

    const result = await resolveTransportContextBootstrap({
      projectDir: '/tmp/project',
      transportConfig: {},
    });

    expect(result).toEqual({
      namespace: {
        scope: 'personal',
        projectId: 'github.com/acme/repo',
      },
      diagnostics: ['namespace:server-personal-fallback', 'server-no-enterprise', 'remote-source:personal'],
      remoteProcessedFreshness: 'fresh',
      localProcessedFreshness: 'missing',
      retryExhausted: true,
    });
  });

  it('includes local processed freshness for the resolved namespace', async () => {
    const now = Date.now();
    detectRepoMock.mockResolvedValue({
      info: {
        remoteUrl: 'git@github.com:acme/repo.git',
      },
    });
    writeProcessedProjection({
      namespace: {
        scope: 'personal',
        projectId: 'github.com/acme/repo',
      },
      class: 'recent_summary',
      sourceEventIds: ['evt-1'],
      summary: 'summary',
      content: { foo: 'bar' },
      createdAt: now - 10,
      updatedAt: now,
    });

    const result = await resolveTransportContextBootstrap({
      projectDir: '/tmp/project',
      transportConfig: {},
    });

    expect(result).toMatchObject({
      namespace: {
        scope: 'personal',
        projectId: 'github.com/acme/repo',
      },
      diagnostics: ['namespace:git-origin'],
      localProcessedFreshness: 'fresh',
    });
  });

  it('reports stale local processed freshness for old processed projections', async () => {
    const now = Date.now();
    detectRepoMock.mockResolvedValue({
      info: {
        remoteUrl: 'git@github.com:acme/repo.git',
      },
    });
    writeProcessedProjection({
      namespace: {
        scope: 'personal',
        projectId: 'github.com/acme/repo',
      },
      class: 'recent_summary',
      sourceEventIds: ['evt-1'],
      summary: 'summary',
      content: { foo: 'bar' },
      createdAt: now - 8 * 60 * 60 * 1000,
      updatedAt: now - 7 * 60 * 60 * 1000,
    });

    const result = await resolveTransportContextBootstrap({
      projectDir: '/tmp/project',
      transportConfig: {},
    });

    expect(result).toMatchObject({
      namespace: {
        scope: 'personal',
        projectId: 'github.com/acme/repo',
      },
      diagnostics: ['namespace:git-origin'],
      localProcessedFreshness: 'stale',
    });
  });

  it('omits transport startup memory when the resolved namespace has no processed memory', async () => {
    detectRepoMock.mockResolvedValue({
      info: {
        remoteUrl: 'git@github.com:acme/repo.git',
      },
    });

    const result = await resolveTransportContextBootstrap({
      projectDir: '/tmp/project',
      transportConfig: {},
    });

    expect(result.namespace).toEqual({
      scope: 'personal',
      projectId: 'github.com/acme/repo',
    });
    expect(result.localProcessedFreshness).toBe('missing');
    expect(result.startupMemory).toBeUndefined();
  });

  it('includes transport startup memory when the resolved namespace has processed memory', async () => {
    const now = Date.now();
    detectRepoMock.mockResolvedValue({
      info: {
        remoteUrl: 'git@github.com:acme/repo.git',
      },
    });
    writeProcessedProjection({
      namespace: {
        scope: 'personal',
        projectId: 'github.com/acme/repo',
      },
      class: 'recent_summary',
      sourceEventIds: ['evt-startup'],
      summary: 'Startup memory should be available at launch',
      content: { kind: 'startup' },
      createdAt: now - 100,
      updatedAt: now - 50,
    });

    const result = await resolveTransportContextBootstrap({
      projectDir: '/tmp/project',
      transportConfig: {},
    });

    expect(result.startupMemory).toEqual(expect.objectContaining({
      reason: 'startup',
      runtimeFamily: 'transport',
      items: expect.arrayContaining([
        expect.objectContaining({
          projectId: 'github.com/acme/repo',
          summary: 'Startup memory should be available at launch',
        }),
      ]),
    }));
  });



  it('buildTransportStartupMemory keeps up to 7 durable plus 8 recent memories', () => {
    const now = Date.now();
    const namespace = {
      scope: 'personal' as const,
      projectId: 'github.com/acme/repo-limit',
    };
    for (let i = 0; i < 10; i++) {
      writeProcessedProjection({
        namespace,
        class: 'durable_memory_candidate',
        sourceEventIds: [`evt-durable-${i}`],
        summary: `Durable memory ${i}`,
        content: {},
        createdAt: now - (2000 + i),
        updatedAt: now - (1000 + i),
      });
    }
    for (let i = 0; i < 12; i++) {
      writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: [`evt-recent-${i}`],
        summary: `Recent memory ${i}`,
        content: {},
        createdAt: now - (500 + i),
        updatedAt: now - i,
      });
    }

    const startup = buildTransportStartupMemory(namespace);

    expect(startup?.items).toHaveLength(15);
    expect(startup?.items.filter((item) => item.projectionClass === 'durable_memory_candidate')).toHaveLength(7);
    expect(startup?.items.filter((item) => item.projectionClass === 'recent_summary')).toHaveLength(8);
    expect(startup?.items.slice(0, 7).every((item) => item.projectionClass === 'durable_memory_candidate')).toBe(true);
  });

  it('buildTransportStartupMemory mixes important and recent startup memories with durable entries first', () => {
    const now = Date.now();
    const namespace = {
      scope: 'personal' as const,
      projectId: 'github.com/acme/repo',
    };
    writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-recent'],
      summary: 'Recent startup memory',
      content: {},
      createdAt: now - 100,
      updatedAt: now - 80,
    });
    writeProcessedProjection({
      namespace,
      class: 'durable_memory_candidate',
      sourceEventIds: ['evt-durable'],
      summary: 'Important architecture memory',
      content: {},
      createdAt: now - 200,
      updatedAt: now - 50,
    });

    const startup = buildTransportStartupMemory(namespace);

    expect(startup?.items.map((item) => ({ summary: item.summary, projectionClass: item.projectionClass }))).toEqual([
      { summary: 'Important architecture memory', projectionClass: 'durable_memory_candidate' },
      { summary: 'Recent startup memory', projectionClass: 'recent_summary' },
    ]);
    expect(startup?.injectedText).toContain('[important] Important architecture memory');
    expect(startup?.injectedText).toContain('[recent] Recent startup memory');
  });

  it('buildTransportStartupMemory filters by full namespace instead of project id only', () => {
    const now = Date.now();
    writeProcessedProjection({
      namespace: {
        scope: 'personal',
        projectId: 'github.com/acme/repo',
        userId: 'user-1',
      },
      class: 'recent_summary',
      sourceEventIds: ['evt-personal'],
      summary: 'Personal startup memory',
      content: {},
      createdAt: now - 100,
      updatedAt: now - 50,
    });
    writeProcessedProjection({
      namespace: {
        scope: 'project_shared',
        projectId: 'github.com/acme/repo',
        enterpriseId: 'ent-1',
        workspaceId: 'ws-1',
      },
      class: 'recent_summary',
      sourceEventIds: ['evt-shared'],
      summary: 'Shared startup memory',
      content: {},
      createdAt: now - 90,
      updatedAt: now - 40,
    });

    const personalStartup = buildTransportStartupMemory({
      scope: 'personal',
      projectId: 'github.com/acme/repo',
      userId: 'user-1',
    });
    const sharedStartup = buildTransportStartupMemory({
      scope: 'project_shared',
      projectId: 'github.com/acme/repo',
      enterpriseId: 'ent-1',
      workspaceId: 'ws-1',
    });

    expect(personalStartup?.items).toHaveLength(1);
    expect(personalStartup?.items[0]?.summary).toContain('Personal');
    expect(personalStartup?.injectedText).toContain('reference only');
    expect(sharedStartup?.items).toHaveLength(1);
    expect(sharedStartup?.items[0]?.summary).toContain('Shared');
  });
});
