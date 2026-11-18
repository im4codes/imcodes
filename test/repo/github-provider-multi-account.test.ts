import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetGhAuthCacheForTests } from '../../src/repo/gh-auth.js';
import { GitHubProvider } from '../../src/repo/github-provider.js';
import { setRepoExecFile } from '../../src/repo/repo-exec.js';

interface RecordedCall {
  file: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

function makeGhError(opts: { exitCode?: number; code?: number; stderr?: string; message?: string }) {
  const err = new Error(opts.message ?? opts.stderr ?? 'gh error') as Error & {
    exitCode?: number;
    code?: number;
    stderr?: string;
  };
  if (opts.exitCode !== undefined) err.exitCode = opts.exitCode;
  if (opts.code !== undefined) err.code = opts.code;
  if (opts.stderr !== undefined) err.stderr = opts.stderr;
  return err;
}

describe('GitHubProvider multi-account gh auth resolution', () => {
  let calls: RecordedCall[];

  beforeEach(() => {
    calls = [];
    resetGhAuthCacheForTests();
    vi.stubEnv('GH_TOKEN', '');
    vi.stubEnv('GITHUB_TOKEN', '');
  });

  afterEach(() => {
    setRepoExecFile(null);
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetGhAuthCacheForTests();
  });

  it('uses default environment without invoking gh auth when GH_TOKEN or GITHUB_TOKEN is set', async () => {
    for (const [envKey, envVal] of [
      ['GH_TOKEN', 'ghp_explicit_env_token_123456'],
      ['GITHUB_TOKEN', 'github_pat_explicit_env_123456'],
    ] as const) {
      calls = [];
      resetGhAuthCacheForTests();
      vi.stubEnv('GH_TOKEN', '');
      vi.stubEnv('GITHUB_TOKEN', '');
      vi.stubEnv(envKey, envVal);

      const impl = async (file: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
        calls.push({ file, args, env: opts?.env });
        return { stdout: JSON.stringify({ workflow_runs: [] }), stderr: '' };
      };
      // listActions expects array from jq output
      const arrayImpl = async (file: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
        calls.push({ file, args, env: opts?.env });
        return { stdout: '[]', stderr: '' };
      };
      void impl;
      setRepoExecFile({ offMain: arrayImpl, offMainIdempotent: arrayImpl });

      const provider = new GitHubProvider('im4codes', 'imcodes', '/tmp/project');
      const res = await provider.listActions();
      expect(res.items).toEqual([]);
      expect(calls).toHaveLength(1);
      expect(calls[0].file).toBe('gh');
      expect(calls[0].args[0]).toBe('api');
      expect(calls[0].env).toBeUndefined();
    }
  });

  it('resolves non-active owner token via gh auth token --user and injects GH_TOKEN across all GitHubProvider methods', async () => {
    const im4Token = 'gho_im4codes_secret_token_999';
    const rockToken = 'gho_rockkoca_active_token_111';
    const tokenCalls: string[] = [];

    const mockExec = async (file: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ file, args, env: opts?.env });

      if (file === 'git') {
        return { stdout: 'main\n', stderr: '' };
      }

      if (file === 'gh' && args[0] === 'auth' && args[1] === 'token') {
        const userIdx = args.indexOf('--user');
        const user = userIdx >= 0 ? args[userIdx + 1] : '';
        tokenCalls.push(user);
        if (user === 'im4codes') return { stdout: `${im4Token}\n`, stderr: '' };
        if (user === 'rockkoca') return { stdout: `${rockToken}\n`, stderr: '' };
        throw makeGhError({ exitCode: 1, stderr: 'unknown user' });
      }

      if (file === 'gh' && args[0] === 'api') {
        const effectiveToken = opts?.env?.GH_TOKEN ?? rockToken;
        if (effectiveToken !== im4Token) {
          throw makeGhError({ exitCode: 1, stderr: 'gh: Not Found (HTTP 404)' });
        }

        const endpoint = args[1] ?? '';
        if (endpoint.includes('/actions/runs/42/jobs')) {
          return { stdout: JSON.stringify({ runId: 42, jobs: [] }), stderr: '' };
        }
        if (endpoint.includes('/actions/runs')) {
          return { stdout: JSON.stringify([]), stderr: '' };
        }
        if (endpoint.includes('/issues/7/comments')) {
          return { stdout: JSON.stringify([]), stderr: '' };
        }
        if (endpoint.includes('/issues/7')) {
          return {
            stdout: JSON.stringify({
              id: '7',
              number: 7,
              title: 'Issue 7',
              body: 'body',
              state: 'open',
              author: 'im4codes',
              labels: [],
              url: 'https://github.com/im4codes/imcodes/issues/7',
              assignee: null,
              createdAt: 1000,
              updatedAt: 2000,
            }),
            stderr: '',
          };
        }
        if (endpoint.includes('/issues?')) {
          return { stdout: JSON.stringify({ rawCount: 0, items: [] }), stderr: '' };
        }
        if (endpoint.includes('/pulls/9')) {
          return {
            stdout: JSON.stringify({
              number: 9,
              title: 'PR 9',
              state: 'open',
              author: 'im4codes',
              head: 'feat',
              base: 'main',
              url: 'https://github.com/im4codes/imcodes/pull/9',
              createdAt: 1000,
              updatedAt: 2000,
              reviewDecision: null,
              draft: false,
              labels: [],
              body: 'pr body',
              additions: 1,
              deletions: 0,
              changedFiles: 1,
              comments: 0,
              mergeable: true,
              mergeableState: 'clean',
            }),
            stderr: '',
          };
        }
        if (endpoint.includes('/pulls?')) {
          return { stdout: JSON.stringify([]), stderr: '' };
        }
        if (endpoint.includes('/branches')) {
          return { stdout: JSON.stringify([{ name: 'main', lastCommitDate: 1000 }]), stderr: '' };
        }
        if (endpoint === '/repos/im4codes/imcodes') {
          return { stdout: 'main\n', stderr: '' };
        }
        if (endpoint.includes('/commits/abc1234')) {
          return {
            stdout: JSON.stringify({
              sha: 'abc123456789',
              shortSha: 'abc1234',
              message: 'init',
              author: 'im4codes',
              date: 1000,
              url: 'https://github.com/im4codes/imcodes/commit/abc1234',
              body: '',
              stats: { additions: 1, deletions: 0, filesChanged: 1 },
              files: [],
              hasMoreFiles: false,
            }),
            stderr: '',
          };
        }
        if (endpoint.includes('/commits?')) {
          return { stdout: JSON.stringify([]), stderr: '' };
        }
      }

      throw new Error(`Unexpected call: ${file} ${args.join(' ')}`);
    };

    setRepoExecFile({ offMain: mockExec, offMainIdempotent: mockExec });
    const provider = new GitHubProvider('im4codes', 'imcodes', '/tmp/project');

    await provider.listIssues();
    await provider.listPRs();
    await provider.listBranches();
    await provider.listCommits();
    await provider.listActions();
    await provider.getActionDetail(42);
    await provider.getCommitDetail('abc1234');
    await provider.getPRDetail(9);
    await provider.getIssueDetail(7);

    // Token resolved once via --user im4codes and reused from cache across all 11 gh api calls
    expect(tokenCalls).toEqual(['im4codes']);

    const apiCalls = calls.filter((c) => c.file === 'gh' && c.args[0] === 'api');
    expect(apiCalls).toHaveLength(11);
    for (const c of apiCalls) {
      expect(c.env?.GH_TOKEN).toBe(im4Token);
    }
  });

  it('invalidates cached token on 401/404, re-resolves once, and respects 5-minute TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    let currentToken = 'gho_im4_v1_token';
    let tokenFetchCount = 0;

    const mockExec = async (file: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ file, args, env: opts?.env });

      if (file === 'gh' && args[0] === 'auth' && args[1] === 'token') {
        tokenFetchCount += 1;
        return { stdout: `${currentToken}\n`, stderr: '' };
      }

      if (file === 'gh' && args[0] === 'api') {
        if (opts?.env?.GH_TOKEN !== currentToken) {
          throw makeGhError({ exitCode: 1, stderr: 'HTTP 401 Bad credentials' });
        }
        return { stdout: '[]', stderr: '' };
      }

      throw makeGhError({ exitCode: 1, stderr: 'unexpected' });
    };

    setRepoExecFile({ offMain: mockExec, offMainIdempotent: mockExec });
    const provider = new GitHubProvider('im4codes', 'imcodes', '/tmp/project');

    // First call resolves v1 and caches it
    await provider.listActions();
    expect(tokenFetchCount).toBe(1);

    // Second call inside 5m TTL uses cached v1 without fetching
    await provider.listActions();
    expect(tokenFetchCount).toBe(1);

    // Simulate token rotation: cached v1 now 401s -> invalidates cache and refreshes v2
    currentToken = 'gho_im4_v2_token';
    await provider.listActions();
    expect(tokenFetchCount).toBe(2);

    // Advance past 5-minute TTL -> expires cache and fetches again
    vi.advanceTimersByTime(5 * 60_000 + 1);
    await provider.listActions();
    expect(tokenFetchCount).toBe(3);
  });

  it('falls back to non-active github.com accounts for org repos and caches the winning login', async () => {
    const aliceToken = 'gho_alice_no_access_123';
    const bobToken = 'gho_bob_org_member_456';
    let statusCalls = 0;
    const tokenRequests: string[] = [];

    const mockExec = async (file: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ file, args, env: opts?.env });

      if (file === 'gh' && args[0] === 'auth' && args[1] === 'token') {
        const user = args[args.indexOf('--user') + 1];
        tokenRequests.push(user);
        if (user === 'my-org') {
          throw makeGhError({ exitCode: 1, stderr: 'no token for user my-org' });
        }
        if (user === 'alice') return { stdout: `${aliceToken}\n`, stderr: '' };
        if (user === 'bob') return { stdout: `${bobToken}\n`, stderr: '' };
        throw makeGhError({ exitCode: 1, stderr: 'unknown user' });
      }

      if (file === 'gh' && args[0] === 'auth' && args[1] === 'status') {
        statusCalls += 1;
        expect(args).toEqual(['auth', 'status', '--json', 'hosts']);
        return {
          stdout: JSON.stringify({
            hosts: {
              'github.com': [
                { login: 'rockkoca', state: 'success', active: true },
                { login: 'broken', state: 'error', active: false },
                { login: 'alice', state: 'success', active: false },
                { login: 'bob', state: 'success', active: false },
              ],
            },
          }),
          stderr: '',
        };
      }

      if (file === 'gh' && args[0] === 'api') {
        if (opts?.env?.GH_TOKEN === bobToken) {
          return { stdout: JSON.stringify([{ id: 1, name: 'CI', status: 'success', branch: 'main', commitSha: 'abcdef1', commitMessage: 'ok', actor: 'bob', url: 'https://github.com/my-org/priv/actions/runs/1', createdAt: 1000, updatedAt: 2000, duration: 1, runNumber: 1, event: 'push', conclusion: 'success', runAttempt: 1, workflowPath: '.github/workflows/ci.yml', headCommitMessage: 'ok' }]), stderr: '' };
        }
        throw makeGhError({ exitCode: 1, stderr: 'gh: Not Found (HTTP 404)' });
      }

      throw new Error(`Unexpected call: ${file}`);
    };

    setRepoExecFile({ offMain: mockExec, offMainIdempotent: mockExec });
    const provider = new GitHubProvider('my-org', 'priv', '/tmp/project');

    const first = await provider.listActions();
    expect(first.items).toHaveLength(1);
    expect(statusCalls).toBe(1);
    // rockkoca (active) and broken (error state) were skipped
    expect(tokenRequests).toEqual(['my-org', 'alice', 'bob']);

    // Second call uses cached bobToken directly without calling auth status or auth token again
    const second = await provider.listActions();
    expect(second.items).toHaveLength(1);
    expect(statusCalls).toBe(1);
    expect(tokenRequests).toEqual(['my-org', 'alice', 'bob']);
  });

  it('gracefully tolerates older gh CLI without --json hosts and preserves typed RepoErrors without falling back on rate limit', async () => {
    const mockExec = async (file: string, args: string[]) => {
      calls.push({ file, args });
      if (file === 'gh' && args[0] === 'auth' && args[1] === 'token') {
        throw makeGhError({ exitCode: 1, stderr: 'no token' });
      }
      if (file === 'gh' && args[0] === 'auth' && args[1] === 'status') {
        // Older gh 2.45.0 rejects `--json`
        throw makeGhError({ exitCode: 1, stderr: 'unknown flag: --json' });
      }
      if (file === 'gh' && args[0] === 'api') {
        if (args[1]?.includes('rate-limit-repo')) {
          throw makeGhError({ exitCode: 1, stderr: 'HTTP 429 API rate limit exceeded' });
        }
        throw makeGhError({ exitCode: 4, stderr: 'authentication failed' });
      }
      throw new Error('unexpected');
    };

    setRepoExecFile({ offMain: mockExec, offMainIdempotent: mockExec });

    // Rate limit should NOT trigger gh auth status fallback
    const rlProvider = new GitHubProvider('other-org', 'rate-limit-repo', '/tmp/project');
    await expect(rlProvider.listActions()).rejects.toMatchObject({ code: 'rate_limited' });
    expect(calls.some((c) => c.args[0] === 'auth' && c.args[1] === 'status')).toBe(false);

    // 404/auth failure tries gh auth status, tolerates old gh error, and throws typed unauthorized error
    const authProvider = new GitHubProvider('other-org', 'missing-repo', '/tmp/project');
    await expect(authProvider.listActions()).rejects.toMatchObject({ code: 'unauthorized' });
    expect(calls.some((c) => c.args[0] === 'auth' && c.args[1] === 'status')).toBe(true);
  });

  it('redacts GitHub tokens from thrown error messages in listActions and getActionDetail', async () => {
    const leakedToken = 'gho_super_secret_leaked_token_XYZ987';
    const patToken = 'github_pat_another_secret_token_ABC123';

    const mockExec = async (file: string, args: string[]) => {
      if (file === 'gh' && args[0] === 'auth' && args[1] === 'token') {
        return { stdout: `${leakedToken}\n`, stderr: '' };
      }
      if (file === 'gh' && args[0] === 'api') {
        throw makeGhError({
          exitCode: 1,
          stderr: `HTTP 500 server error with token ${leakedToken} and ${patToken}`,
        });
      }
      throw makeGhError({ exitCode: 1, stderr: 'unknown' });
    };

    setRepoExecFile({ offMain: mockExec, offMainIdempotent: mockExec });
    const provider = new GitHubProvider('im4codes', 'imcodes', '/tmp/project');

    let listErr: Error | undefined;
    try {
      await provider.listActions();
    } catch (e) {
      listErr = e as Error;
    }
    expect(listErr).toBeDefined();
    expect(listErr!.message).not.toContain(leakedToken);
    expect(listErr!.message).not.toContain(patToken);
    expect(listErr!.message).toContain('[REDACTED]');

    let detailErr: Error | undefined;
    try {
      await provider.getActionDetail(10);
    } catch (e) {
      detailErr = e as Error;
    }
    expect(detailErr).toBeDefined();
    expect(detailErr!.message).not.toContain(leakedToken);
    expect(detailErr!.message).not.toContain(patToken);
    expect(detailErr!.message).toContain('[REDACTED]');
  });
});
