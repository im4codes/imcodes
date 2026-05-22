/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { browserOpenMock } = vi.hoisted(() => ({
  browserOpenMock: vi.fn(),
}));

vi.mock('@capacitor/browser', () => ({
  Browser: {
    open: (...args: unknown[]) => browserOpenMock(...args),
  },
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function blobResponse(body = 'file', headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers,
  });
}

class MockXmlHttpRequest {
  static instances: MockXmlHttpRequest[] = [];

  method = '';
  url = '';
  body: unknown = null;
  status = 200;
  responseText = JSON.stringify({
    ok: true,
    attachment: {
      id: 'att-1',
      source: 'upload',
      serverId: 'srv-1',
      daemonPath: '/tmp/readme.txt',
      createdAt: '2026-05-11T00:00:00Z',
      downloadable: true,
    },
  });
  withCredentials = false;
  headers = new Map<string, string>();
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onprogress: (() => void) | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    MockXmlHttpRequest.instances.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(key: string, value: string) {
    this.headers.set(key, value);
  }

  send(body: unknown) {
    this.body = body;
    this.upload.onprogress?.({ lengthComputable: true, loaded: 6, total: 12 } as ProgressEvent);
    this.upload.onprogress?.({ lengthComputable: true, loaded: 12, total: 12 } as ProgressEvent);
    this.responseText = JSON.stringify({
      type: 'file.upload_progress',
      uploadId: 'upload-1',
      loaded: 5,
      total: 10,
    }) + '\n';
    this.onprogress?.();
    this.responseText += JSON.stringify({
      type: 'file.upload_done',
      uploadId: 'upload-1',
      ok: true,
      attachment: {
        id: 'att-1',
        source: 'upload',
        serverId: 'srv-1',
        daemonPath: '/tmp/readme.txt',
        createdAt: '2026-05-11T00:00:00Z',
        downloadable: true,
      },
    }) + '\n';
    this.onload?.();
  }
}

describe('shared-context and file API contracts', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('XMLHttpRequest', MockXmlHttpRequest);
    browserOpenMock.mockReset();
    MockXmlHttpRequest.instances = [];
    document.body.innerHTML = '';
    document.cookie = 'rcc_csrf=csrf-token';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.cookie = 'rcc_csrf=; Max-Age=0; path=/';
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
  });

  it('keeps team and shared-context wrappers on stable HTTP contracts', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (url, init) => {
      const path = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();

      if (path === '/api/team' && method === 'GET') return jsonResponse({ teams: [{ id: 'team-1', name: 'Core', role: 'owner' }] });
      if (path === '/api/team' && method === 'POST') return jsonResponse({ id: 'team-2', name: 'Ops', role: 'owner' });
      if (path.includes('/api/team/team-1') && method === 'GET') return jsonResponse({ id: 'team-1', name: 'Core', myRole: 'owner', members: [] });
      if (path.includes('/api/team/join/')) return jsonResponse({ ok: true, teamId: 'team-1', role: 'member' });
      if (path.includes('/invite')) return jsonResponse({ token: 'invite-token', expiresAt: 1778457600000 });
      if (path.includes('/member/') && method === 'PUT') return jsonResponse({ ok: true });
      if (path.includes('/member/') && method === 'DELETE') return jsonResponse({ ok: true });

      if (path.endsWith('/shared-context/runtime-config') && method === 'GET') return jsonResponse({ snapshot: { enabled: true } });
      if (path.endsWith('/shared-context/runtime-config') && method === 'PUT') return jsonResponse({ snapshot: { enabled: false } });
      if (path.includes('/workspaces') && method === 'GET') return jsonResponse({ workspaces: [{ id: 'ws-1', enterpriseId: 'ent-1', name: 'Platform' }] });
      if (path.includes('/workspaces') && method === 'POST') return jsonResponse({ id: 'ws-2', enterpriseId: 'ent-1', name: 'Tools' });
      if (path.includes('/projects/enroll-1/policy') && method === 'GET') {
        return jsonResponse({
          enrollmentId: 'enroll-1',
          enterpriseId: 'ent-1',
          allowDegradedProviderSupport: true,
          allowLocalFallback: false,
          requireFullProviderSupport: true,
        });
      }
      if (path.includes('/projects/enroll-1/policy') && method === 'PUT') return jsonResponse({ ok: true });
      if (path.includes('/pending-removal') || path.includes('/remove')) return jsonResponse({ ok: true });
      if (path.includes('/projects/enroll')) return jsonResponse({ id: 'enroll-1' });
      if (path.includes('/projects') && method === 'GET') return jsonResponse({ projects: [{ id: 'proj-1', workspaceId: 'ws-1', canonicalRepoId: 'github:org/repo', displayName: 'Repo', scope: 'repository', status: 'active' }] });

      if (path.includes('/versions') && method === 'POST') return jsonResponse({ id: 'ver-1', documentId: 'doc-1', versionNumber: 2, status: 'draft' });
      if (path.includes('/documents') && method === 'GET') return jsonResponse({ documents: [{ id: 'doc-1', enterpriseId: 'ent-1', kind: 'repo_playbook', title: 'Playbook', versions: [] }] });
      if (path.includes('/documents') && method === 'POST') return jsonResponse({ id: 'doc-2' });
      if (path.includes('/document-versions/ver-1/activate')) return jsonResponse({ ok: true, versionId: 'ver-1', status: 'active' });
      if (path.includes('/document-bindings') && method === 'GET') return jsonResponse({ bindings: [{ id: 'bind-1', workspaceId: 'ws-1', enrollmentId: null, documentId: 'doc-1', versionId: 'ver-1', mode: 'required', applicabilityRepoId: null, applicabilityLanguage: null, applicabilityPathPattern: null, status: 'active' }] });
      if (path.includes('/document-bindings') && method === 'POST') return jsonResponse({ id: 'bind-2' });
      if (path.includes('/runtime-authored-context')) return jsonResponse({ bindings: [{ bindingId: 'bind-1', documentVersionId: 'ver-1', mode: 'required', scope: 'repository', content: 'Use tests', active: true, superseded: false }] });
      if (path.includes('/diagnostics')) {
        return jsonResponse({
          enterpriseId: 'ent-1',
          canonicalRepoId: 'github:org/repo',
          enrollmentId: 'enroll-1',
          remoteProcessedFreshness: 'fresh',
          visibilityState: 'active',
          retrievalMode: 'shared_active',
          policy: { allowDegradedProviderSupport: true, allowLocalFallback: false, requireFullProviderSupport: true },
          diagnostics: { derivedOnDemand: false, persistedSnapshotAvailable: true, activeBindingCount: 1, appliedDocumentVersionIds: ['ver-1'] },
        });
      }
      if (path.includes('/personal-memory') && method === 'GET') return jsonResponse({ items: [{ id: 'mem-1', content: 'memory' }] });
      if (path.includes('/personal-memory') && method === 'DELETE') return jsonResponse({ ok: true });
      if (path.includes('/memory') && method === 'GET') return jsonResponse({ items: [{ id: 'mem-2', content: 'shared' }] });
      if (path.includes('/memory') && method === 'DELETE') return jsonResponse({ ok: true });

      return jsonResponse({ ok: true });
    });

    const api = await import('../src/api.js');

    await expect(api.listTeams()).resolves.toEqual([{ id: 'team-1', name: 'Core', role: 'owner' }]);
    await expect(api.createTeam('Ops')).resolves.toMatchObject({ id: 'team-2' });
    await expect(api.getTeam('team-1')).resolves.toMatchObject({ myRole: 'owner' });
    await expect(api.createTeamInvite('team-1', 'member', '  user@example.com  ')).resolves.toMatchObject({ token: 'invite-token' });
    await expect(api.joinTeamByToken('invite/token')).resolves.toMatchObject({ ok: true, teamId: 'team-1' });
    await expect(api.updateTeamMemberRole('team-1', 'user/2', 'admin')).resolves.toEqual({ ok: true });
    await expect(api.removeTeamMember('team-1', 'user/2')).resolves.toEqual({ ok: true });

    await expect(api.fetchSharedContextRuntimeConfig('srv/1')).resolves.toMatchObject({ snapshot: { enabled: true } });
    await expect(api.updateSharedContextRuntimeConfig('srv/1', { enabled: false } as any)).resolves.toMatchObject({ snapshot: { enabled: false } });
    await expect(api.listSharedWorkspaces('ent/1')).resolves.toHaveLength(1);
    await expect(api.createSharedWorkspace('ent/1', 'Tools')).resolves.toMatchObject({ id: 'ws-2' });
    await expect(api.listSharedProjects('ent/1')).resolves.toHaveLength(1);
    await expect(api.enrollSharedProject('ent/1', { canonicalRepoId: 'github:org/repo', displayName: 'Repo', workspaceId: 'ws-1', scope: 'repository' })).resolves.toEqual({ id: 'enroll-1' });
    await expect(api.updateSharedProjectPolicy('enroll-1', { allowDegradedProviderSupport: true, allowLocalFallback: false, requireFullProviderSupport: true })).resolves.toEqual({ ok: true });
    await expect(api.getSharedProjectPolicy('enroll-1')).resolves.toMatchObject({ enrollmentId: 'enroll-1' });
    await expect(api.markSharedProjectPendingRemoval('enroll-1')).resolves.toEqual({ ok: true });
    await expect(api.removeSharedProject('enroll-1')).resolves.toEqual({ ok: true });

    await expect(api.listSharedDocuments('ent/1')).resolves.toHaveLength(1);
    await expect(api.createSharedDocument('ent/1', { kind: 'repo_playbook', title: 'Playbook' })).resolves.toEqual({ id: 'doc-2' });
    await expect(api.createSharedDocumentVersion('doc/1', { contentMd: 'rules', label: 'v2' })).resolves.toMatchObject({ id: 'ver-1' });
    await expect(api.activateSharedDocumentVersion('ver-1')).resolves.toMatchObject({ status: 'active' });
    await expect(api.listSharedDocumentBindings('ent/1')).resolves.toHaveLength(1);
    await expect(api.createSharedDocumentBinding('ent/1', { documentId: 'doc-1', versionId: 'ver-1', workspaceId: 'ws-1', mode: 'required', applicabilityLanguage: 'ts' })).resolves.toEqual({ id: 'bind-2' });
    await expect(api.getRuntimeAuthoredContext('ent/1', { canonicalRepoId: 'github:org/repo', workspaceId: 'ws-1', enrollmentId: 'enroll-1', language: 'ts', filePath: 'src/app.ts' })).resolves.toHaveLength(1);
    await expect(api.getSharedContextDiagnostics('ent/1', 'github:org/repo', { workspaceId: 'ws-1', enrollmentId: 'enroll-1', language: 'ts', filePath: 'src/app.ts' })).resolves.toMatchObject({ retrievalMode: 'shared_active' });
    await expect(api.getPersonalCloudMemory({ projectId: 'proj-1', projectionClass: 'recent_summary', query: 'auth', limit: 5 })).resolves.toMatchObject({ items: [{ id: 'mem-1' }] });
    await expect(api.getEnterpriseSharedMemory('ent/1', { canonicalRepoId: 'github:org/repo', projectionClass: 'durable_memory_candidate', query: 'test', limit: 3 })).resolves.toMatchObject({ items: [{ id: 'mem-2' }] });
    await expect(api.deletePersonalCloudMemory('mem/1')).resolves.toEqual({ ok: true });
    await expect(api.deleteEnterpriseSharedMemory('ent/1', 'mem/2')).resolves.toEqual({ ok: true });

    const requests = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: (init as RequestInit | undefined)?.method ?? 'GET',
      body: (init as RequestInit | undefined)?.body,
    }));
    expect(requests).toContainEqual(expect.objectContaining({ method: 'POST', url: '/api/team' }));
    expect(requests).toContainEqual(expect.objectContaining({ method: 'POST', url: '/api/team/team-1/invite' }));
    expect(JSON.parse(String(requests.find((request) => request.url === '/api/team/team-1/invite')?.body))).toEqual({
      role: 'member',
      email: 'user@example.com',
    });
    expect(requests.some((request) => request.url.includes('/api/shared-context/enterprises/ent%2F1/runtime-authored-context?canonicalRepoId=github%3Aorg%2Frepo&workspaceId=ws-1&enrollmentId=enroll-1&language=ts&filePath=src%2Fapp.ts'))).toBe(true);
    expect(requests.some((request) => request.url.includes('/api/shared-context/personal-memory?projectId=proj-1&projectionClass=recent_summary&query=auth&limit=5'))).toBe(true);
  });

  it('uploads files through XHR with progress and auth headers', async () => {
    const { configure, configureApiKey, uploadFile } = await import('../src/api.js');
    const progress: number[] = [];

    configure('https://api.example/');
    await expect(uploadFile('srv-1', new File(['hello'], 'readme.txt'), (pct) => progress.push(pct)))
      .resolves.toMatchObject({ ok: true, attachment: { id: 'att-1' } });

    const browserUpload = MockXmlHttpRequest.instances[0];
    expect(browserUpload.method).toBe('POST');
    expect(browserUpload.url).toBe('https://api.example/api/server/srv-1/upload');
    expect(browserUpload.withCredentials).toBe(true);
    expect(browserUpload.headers.get('Accept')).toBe('application/x-ndjson, application/json');
    expect(browserUpload.headers.get('X-CSRF-Token')).toBe('csrf-token');
    expect(progress).toEqual([25, 50, 75, 100]);

    configureApiKey('native-key');
    await uploadFile('srv-2', new File(['hello'], 'notes.txt'));
    const nativeUpload = MockXmlHttpRequest.instances[1];
    expect(nativeUpload.headers.get('Authorization')).toBe('Bearer native-key');
    expect(nativeUpload.withCredentials).toBe(false);
  });

  it('downloads and previews attachments through desktop and native paths', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(blobResponse('desktop', {
        'Content-Disposition': "attachment; filename*=UTF-8''report%20final.txt",
      }))
      .mockResolvedValueOnce(blobResponse('preview'))
      .mockResolvedValueOnce(jsonResponse({ token: 'x'.repeat(32) }));

    const objectUrlSpy = vi.fn(() => 'blob:imcodes');
    const revokeSpy = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: objectUrlSpy,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeSpy,
    });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    const { configure, downloadAttachment, previewAttachment } = await import('../src/api.js');
    configure('https://api.example');

    await downloadAttachment('srv-1', 'att-1');
    const link = document.querySelector('a');
    expect(clickSpy).toHaveBeenCalledOnce();
    expect(link).toBeNull();

    await previewAttachment('srv-1', 'att-2');
    expect(openSpy).toHaveBeenCalledWith('blob:imcodes', '_blank');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(revokeSpy).toHaveBeenCalledWith('blob:imcodes');

    vi.stubGlobal('Capacitor', {});
    await downloadAttachment('srv-1', 'att-3');
    expect(browserOpenMock).toHaveBeenCalledWith({
      url: `https://api.example/api/server/srv-1/uploads/att-3/download?token=${'x'.repeat(32)}`,
    });
    expect(objectUrlSpy).toHaveBeenCalledTimes(2);
  });
});
