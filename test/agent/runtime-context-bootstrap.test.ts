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

import { resolveTransportContextBootstrap } from '../../src/agent/runtime-context-bootstrap.js';

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

    expect(result).toEqual({
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

    expect(result).toEqual({
      namespace: {
        scope: 'personal',
        projectId: 'github.com/acme/repo',
      },
      diagnostics: ['namespace:git-origin'],
      localProcessedFreshness: 'stale',
    });
  });
});
