/**
 * Unit tests for GitLabProvider CI/CD (pipelines) mapping.
 *
 * The provider shells out to `glab api <path>`. We mock `node:child_process`'s
 * execFile (with the util.promisify.custom hook the provider relies on) and route
 * canned GitLab API JSON by request path — so the mapping is verified deterministically
 * with no `glab`/network dependency. (The live end-to-end path was also confirmed
 * against a real self-hosted GitLab during development.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// path-substring → stdout JSON. Checked in insertion order.
const responses = new Map<string, string>();

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  const execFile: unknown = vi.fn();
  (execFile as { [k: symbol]: unknown })[promisify.custom] = (_cmd: string, args: string[]) => {
    const path = args?.[1] ?? '';
    for (const [needle, body] of responses) {
      if (path.includes(needle)) return Promise.resolve({ stdout: body, stderr: '' });
    }
    return Promise.reject(Object.assign(new Error('no mock for ' + path), { stderr: '404 not found' }));
  };
  return { execFile };
});

import { GitLabProvider } from '../../src/repo/gitlab-provider.js';

const PIPELINES = JSON.stringify([
  { id: 3688, iid: 569, sha: 'f9f28a38e81ed2f0', ref: 'dev/wws', status: 'success', source: 'push',
    created_at: '2026-06-10T12:40:28.511+08:00', updated_at: '2026-06-10T12:48:29.954+08:00',
    web_url: 'http://host:2222/g/p/-/pipelines/3688' },
  { id: 3687, iid: 568, sha: 'deadbeefcafe0001', ref: 'main', status: 'failed', source: 'schedule',
    created_at: '2026-06-10T11:00:00.000+08:00', updated_at: '2026-06-10T11:05:00.000+08:00',
    web_url: 'http://host:2222/g/p/-/pipelines/3687' },
  { id: 3686, iid: 567, sha: 'cafef00dbaadf00d', ref: 'main', status: 'running', source: 'web',
    created_at: '2026-06-10T10:00:00.000+08:00', updated_at: '2026-06-10T10:01:00.000+08:00',
    web_url: 'http://host:2222/g/p/-/pipelines/3686' },
]);
const COMMIT = JSON.stringify({ title: 'fix: something good', message: 'fix: something good\n\nbody' });
const JOBS = JSON.stringify([
  { id: 8351, name: 'package-frontend', stage: 'package', status: 'success',
    started_at: '2026-06-10T12:42:19.585+08:00', finished_at: '2026-06-10T12:48:29.813+08:00',
    web_url: 'http://host:2222/g/p/-/jobs/8351' },
  { id: 8350, name: 'backend-build-test', stage: 'build-test', status: 'failed',
    started_at: '2026-06-10T12:40:30.000+08:00', finished_at: '2026-06-10T12:42:00.000+08:00',
    web_url: 'http://host:2222/g/p/-/jobs/8350' },
]);

describe('GitLabProvider — CI/CD pipelines', () => {
  beforeEach(() => responses.clear());

  it('maps pipelines to RepoWorkflowRun with normalized status + commit-title name', async () => {
    responses.set('/repository/commits/', COMMIT); // enrichment lookup
    responses.set('/pipelines?', PIPELINES);

    const p = new GitLabProvider('grp', 'proj', '/tmp');
    const res = await p.listActions({ perPage: 3 });

    expect(res.items).toHaveLength(3);
    expect(res.page).toBe(1);

    expect(res.items[0]).toMatchObject({
      id: 3688, status: 'success', branch: 'dev/wws', commitSha: 'f9f28a38', runNumber: 569, event: 'push',
      conclusion: 'success', url: 'http://host:2222/g/p/-/pipelines/3688',
    });
    // name comes from the best-effort commit-title enrichment
    expect(res.items[0].name).toBe('fix: something good');
    expect(res.items[0].createdAt).toBeGreaterThan(0);

    // GitLab status normalization
    expect(res.items[1].status).toBe('failure'); // failed
    expect(res.items[2].status).toBe('running');
  });

  it('falls back to the branch ref for name when commit enrichment fails', async () => {
    // No /repository/commits/ mock → enrichment rejects → name degrades to ref.
    responses.set('/pipelines?', PIPELINES);

    const p = new GitLabProvider('grp', 'proj', '/tmp');
    const res = await p.listActions({ perPage: 3 });

    expect(res.items[0].name).toBe('dev/wws');
    expect(res.items[1].name).toBe('main');
  });

  it('maps pipeline jobs to RepoActionJob (stage/name, sorted by id asc)', async () => {
    responses.set('/pipelines/3688/jobs', JOBS);

    const p = new GitLabProvider('grp', 'proj', '/tmp');
    const det = await p.getActionDetail(3688);

    expect(det.runId).toBe(3688);
    expect(det.jobs).toHaveLength(2);
    // sorted by id ascending → 8350 before 8351
    expect(det.jobs[0]).toMatchObject({ id: 8350, name: 'build-test / backend-build-test', status: 'failure', conclusion: 'failed' });
    expect(det.jobs[1]).toMatchObject({ id: 8351, name: 'package / package-frontend', status: 'success' });
    expect(det.jobs[0].startedAt).toBeGreaterThan(0);
    expect(det.jobs[0].completedAt).toBeGreaterThan(0);
    expect(det.jobs[0].steps).toEqual([]);
  });

  it('returns an empty list when CI is unconfigured (pipelines endpoint returns [])', async () => {
    responses.set('/pipelines?', '[]');
    const p = new GitLabProvider('grp', 'proj', '/tmp');
    const res = await p.listActions();
    expect(res.items).toEqual([]);
    expect(res.hasMore).toBe(false);
  });
});
