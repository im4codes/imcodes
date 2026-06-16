import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SKILL_REGISTRY_FILE_NAME, SKILL_REGISTRY_SCHEMA_VERSION, makeSkillUri } from '../../shared/skill-registry-types.js';
import { configureSharedContextRuntime } from '../../src/context/shared-context-runtime.js';
import { resetMemoryShortRefsForTests, resolveMemoryShortRef } from '../../src/context/memory-short-ref.js';
import { ensureContextNamespace, writeContextObservation, writeProcessedProjection } from '../../src/store/context-store.js';
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
  let tempProjectDir: string | undefined;

  beforeEach(() => {
    detectRepoMock.mockReset();
    resetMemoryShortRefsForTests();
    configureSharedContextRuntime(null);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('runtime-context-bootstrap');
  });

  afterEach(async () => {
    await cleanupIsolatedSharedContextDb(tempDir);
    if (tempProjectDir) await rm(tempProjectDir, { recursive: true, force: true });
    tempProjectDir = undefined;
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

  it('accepts explicit user_private namespace through the shared scope registry', async () => {
    const result = await resolveTransportContextBootstrap({
      projectDir: '/tmp/project',
      transportConfig: {
        sharedContextNamespace: {
          scope: 'user_private',
          projectId: 'github.com/acme/repo',
          userId: 'user-1',
        },
      },
    });

    expect(result).toEqual({
      namespace: {
        scope: 'user_private',
        projectId: 'github.com/acme/repo',
        userId: 'user-1',
      },
      diagnostics: ['namespace:explicit'],
      localProcessedFreshness: 'missing',
    });
    expect(detectRepoMock).not.toHaveBeenCalled();
  });

  it('rejects unknown explicit namespace scopes and falls back to repo resolution', async () => {
    detectRepoMock.mockResolvedValue({
      info: {
        remoteUrl: 'git@github.com:acme/repo.git',
      },
    });

    const result = await resolveTransportContextBootstrap({
      projectDir: '/tmp/project',
      transportConfig: {
        sharedContextNamespace: {
          scope: 'rogue_scope',
          projectId: 'github.com/rogue/repo',
        },
      },
    });

    expect(result.namespace).toEqual({
      scope: 'personal',
      projectId: 'github.com/acme/repo',
    });
    expect(result.diagnostics).toEqual(['namespace:git-origin']);
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

  it('includes cloud startup memory for the resolved personal project when backend sync is available', async () => {
    detectRepoMock.mockResolvedValue({
      info: {
        remoteUrl: 'git@github.com:acme/repo.git',
      },
    });
    configureSharedContextRuntime({
      workerUrl: 'https://worker.example',
      serverId: 'srv-1',
      token: 'token-1',
    });
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith('/api/server/srv-1/shared-context/resolve-namespace')) {
        return new Response(JSON.stringify({
          canonicalRepoId: 'github.com/acme/repo',
          namespace: null,
          visibilityState: 'unenrolled',
          remoteProcessedFreshness: 'fresh',
          retryExhausted: true,
          diagnostics: ['remote-personal-fresh'],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href.endsWith('/api/shared-context/memory/search')) {
        expect(init?.headers).toEqual(expect.objectContaining({
          Authorization: 'Bearer token-1',
          'X-Server-Id': 'srv-1',
        }));
        expect(JSON.parse(String(init?.body))).toEqual({
          query: '',
          scope: 'personal',
          projectId: 'github.com/acme/repo',
          limit: 50,
        });
        return new Response(JSON.stringify({
          results: [
            {
              id: 'cloud-durable',
              scope: 'personal',
              class: 'durable_memory_candidate',
              preview: 'Cloud durable startup memory',
              projectId: 'github.com/acme/repo',
              updatedAt: 200,
            },
            {
              id: 'cloud-recent',
              scope: 'personal',
              class: 'recent_summary',
              preview: 'Cloud recent startup memory',
              projectId: 'github.com/acme/repo',
              updatedAt: 100,
            },
            {
              id: 'cloud-other-project',
              scope: 'personal',
              class: 'durable_memory_candidate',
              preview: 'Wrong project must not enter startup memory',
              projectId: 'github.com/acme/other',
              updatedAt: 300,
            },
            {
              id: 'cloud-other-scope',
              scope: 'project_shared',
              class: 'recent_summary',
              preview: 'Wrong scope must not enter startup memory',
              projectId: 'github.com/acme/repo',
              updatedAt: 250,
            },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveTransportContextBootstrap({
      projectDir: '/tmp/project',
      transportConfig: {},
    });

    expect(result.remoteProcessedFreshness).toBe('fresh');
    expect(result.startupMemory).toEqual(expect.objectContaining({
      authoritySource: 'processed_remote',
      sourceKind: 'remote_processed',
      items: expect.arrayContaining([
        expect.objectContaining({
          id: 'cloud-durable',
          projectionClass: 'durable_memory_candidate',
          sourceKind: 'remote_processed',
          summary: 'Cloud durable startup memory',
        }),
        expect.objectContaining({
          id: 'cloud-recent',
          projectionClass: 'recent_summary',
          sourceKind: 'remote_processed',
          summary: 'Cloud recent startup memory',
        }),
      ]),
    }));
    expect(result.startupMemory?.items.map((item) => item.id)).not.toContain('cloud-other-project');
    expect(result.startupMemory?.items.map((item) => item.id)).not.toContain('cloud-other-scope');
  });

  it('buildTransportStartupMemory keeps up to 20 durable plus 30 recent memories', async () => {
    const now = Date.now();
    const namespace = {
      scope: 'personal' as const,
      projectId: 'github.com/acme/repo-limit',
    };
    for (let i = 0; i < 25; i++) {
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
    for (let i = 0; i < 35; i++) {
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

    const startup = await buildTransportStartupMemory(namespace);

    expect(startup?.items).toHaveLength(50);
    expect(startup?.items.filter((item) => item.projectionClass === 'durable_memory_candidate')).toHaveLength(20);
    expect(startup?.items.filter((item) => item.projectionClass === 'recent_summary')).toHaveLength(30);
    expect(startup?.items.slice(0, 20).every((item) => item.projectionClass === 'durable_memory_candidate')).toBe(true);
  });

  it('buildTransportStartupMemory mixes important and recent startup memories with durable entries first', async () => {
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

    const startup = await buildTransportStartupMemory(namespace);

    expect(startup?.items.map((item) => ({ summary: item.summary, projectionClass: item.projectionClass }))).toEqual([
      { summary: 'Important architecture memory', projectionClass: 'durable_memory_candidate' },
      { summary: 'Recent startup memory', projectionClass: 'recent_summary' },
    ]);
    expect(startup?.injectedText).toContain('[important] Important architecture memory');
    expect(startup?.injectedText).toContain('[recent] Recent startup memory');
  });

  it('injects only active or promoted observations as a lightweight startup index', async () => {
    const namespace = {
      scope: 'personal' as const,
      projectId: 'github.com/acme/repo',
      userId: 'user-1',
    };
    const observationNamespace = ensureContextNamespace({
      scope: 'user_private',
      projectId: 'github.com/acme/repo',
      userId: 'user-1',
    }, 100);
    const active = writeContextObservation({
      namespaceId: observationNamespace.id,
      scope: 'user_private',
      class: 'note',
      origin: 'agent_learned',
      fingerprint: 'startup-observation-active',
      content: { text: 'Active saved observation should appear in the startup index.' },
      text: 'Active saved observation should appear in the startup index.',
      state: 'active',
      now: 300,
    });
    const promoted = writeContextObservation({
      namespaceId: observationNamespace.id,
      scope: 'user_private',
      class: 'note',
      origin: 'user_note',
      fingerprint: 'startup-observation-promoted',
      content: { text: 'Promoted saved observation should appear in the startup index.' },
      text: 'Promoted saved observation should appear in the startup index.',
      state: 'promoted',
      now: 250,
    });
    writeContextObservation({
      namespaceId: observationNamespace.id,
      scope: 'user_private',
      class: 'note',
      origin: 'agent_learned',
      fingerprint: 'startup-observation-candidate',
      content: { text: 'Candidate saved observation should not be injected.' },
      text: 'Candidate saved observation should not be injected.',
      state: 'candidate',
      now: 400,
    });

    const startup = await buildTransportStartupMemory(namespace);

    expect(startup?.items).toEqual([
      expect.objectContaining({
        id: active.id,
        type: 'observation',
        summary: expect.stringContaining('Active saved observation'),
      }),
      expect.objectContaining({
        id: promoted.id,
        type: 'observation',
        summary: expect.stringContaining('Promoted saved observation'),
      }),
    ]);
    expect(startup?.injectedText).toContain('<persistent-memory-index advisory="true">');
    const activeRef = `obs:${active.id.slice(0, 10)}`;
    const promotedRef = `obs:${promoted.id.slice(0, 10)}`;
    expect(startup?.injectedText).toContain(`ref: ${activeRef}`);
    expect(startup?.injectedText).toContain(`ref: ${promotedRef}`);
    expect(startup?.injectedText).not.toContain(active.id);
    expect(startup?.injectedText).not.toContain(promoted.id);
    expect(startup?.injectedText).not.toContain('Candidate saved observation');
    expect(startup?.injectedText).toContain('call get_memory_sources with { "ref": "obs:..." }');
    expect(resolveMemoryShortRef(activeRef, {
      scope: 'user_private',
      projectId: 'github.com/acme/repo',
      userId: 'user-1',
    })).toMatchObject({ kind: 'observation', id: active.id });
  });

  it('buildTransportStartupMemory renders registry skill references without reading skill markdown bodies', async () => {
    tempProjectDir = await mkdtemp(join(tmpdir(), 'runtime-skill-project-'));
    const skillDir = join(tempProjectDir, '.imc', 'skills', 'testing');
    await mkdir(skillDir, { recursive: true });
    const missingSkillPath = join(skillDir, 'test-first.md');
    await writeFile(join(tempProjectDir, '.imc', 'skills', SKILL_REGISTRY_FILE_NAME), JSON.stringify({
      schemaVersion: SKILL_REGISTRY_SCHEMA_VERSION,
      generatedAt: 1000,
      entries: [{
        schemaVersion: SKILL_REGISTRY_SCHEMA_VERSION,
        key: 'testing/test-first',
        layer: 'project_escape_hatch',
        metadata: {
          schemaVersion: 1,
          name: 'test-first',
          category: 'testing',
          description: 'Run tests before handoff.',
        },
        path: missingSkillPath,
        displayPath: '.imc/skills/testing/test-first.md',
        uri: makeSkillUri('project_escape_hatch', 'testing/test-first'),
        fingerprint: 'registry-fingerprint',
        updatedAt: 1000,
      }],
    }, null, 2));

    const startup = await buildTransportStartupMemory({
      scope: 'personal',
      projectId: 'github.com/acme/repo',
    }, { projectDir: tempProjectDir, skillsFeatureEnabled: true });

    expect(startup?.items).toEqual([
      expect.objectContaining({
        id: 'skill:project_escape_hatch:testing/test-first',
        scope: 'personal',
      }),
    ]);
    expect(startup?.injectedText).toContain('# Available skills (read on demand)');
    expect(startup?.injectedText).toContain('<startup-skills-index advisory="true">');
    expect(startup?.injectedText).toContain('path: .imc/skills/testing/test-first.md');
    expect(startup?.injectedText).toContain('This is a registry hint only');
    expect(startup?.injectedText).not.toContain('<<<imcodes-skill v1>>>');
    expect(startup?.injectedText).not.toContain('Run tests before final handoff.');
  });

  it('buildTransportStartupMemory filters by full namespace instead of project id only', async () => {
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

    const personalStartup = await buildTransportStartupMemory({
      scope: 'personal',
      projectId: 'github.com/acme/repo',
      userId: 'user-1',
    });
    const sharedStartup = await buildTransportStartupMemory({
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
