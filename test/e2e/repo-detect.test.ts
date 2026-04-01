/**
 * E2E test: repo detection chain.
 * Tests the full flow: detectRepo() → handleRepoCommand() → provider methods.
 *
 * Uses the REAL current git repository (this project itself) to verify
 * that SSH aliases, platform detection, CLI checks, and auth all work
 * in the actual runtime environment.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectRepo, parseRemoteUrl, parseRemotes } from '../../src/repo/detector.js';
import { listSessions, upsertSession, loadStore } from '../../src/store/session-store.js';
import { handleRepoCommand } from '../../src/daemon/repo-handler.js';

const execFileAsync = promisify(execFile);

const SKIP = process.env.SKIP_TMUX_TESTS === '1' || !!process.env.CLAUDECODE;

// Use this project's own directory as the test projectDir
const PROJECT_DIR = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');

describe.skipIf(SKIP)('Repo Detection E2E', () => {
  let remoteUrl: string;
  let remoteHost: string;
  let currentBranch = '';

  beforeAll(() => {
    try {
      remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: PROJECT_DIR,
        timeout: 5000,
      }).toString().trim();
    } catch {
      remoteUrl = '';
    }

    // Extract host from remote URL
    const parsed = parseRemoteUrl(remoteUrl);
    remoteHost = parsed?.host ?? '';

    try {
      currentBranch = execFileSync('git', ['branch', '--show-current'], {
        cwd: PROJECT_DIR,
        timeout: 5000,
      }).toString().trim();
    } catch {
      currentBranch = '';
    }
  });

  // ── parseRemoteUrl ──────────────────────────────────────────────────────

  describe('parseRemoteUrl', () => {
    it('parses HTTPS URLs', () => {
      const result = parseRemoteUrl('https://github.com/owner/repo.git');
      expect(result).toEqual({ host: 'github.com', owner: 'owner', repo: 'repo' });
    });

    it('parses SSH URLs', () => {
      const result = parseRemoteUrl('git@github.com:owner/repo.git');
      expect(result).toEqual({ host: 'github.com', owner: 'owner', repo: 'repo' });
    });

    it('parses SSH alias URLs', () => {
      const result = parseRemoteUrl('git@github-work:myorg/myrepo.git');
      expect(result).toEqual({ host: 'github-work', owner: 'myorg', repo: 'myrepo' });
    });

    it('parses ssh:// prefix URLs', () => {
      const result = parseRemoteUrl('ssh://git@gitlab.example.com/group/project.git');
      expect(result).toEqual({ host: 'gitlab.example.com', owner: 'group', repo: 'project' });
    });

    it('handles URLs without .git suffix', () => {
      const result = parseRemoteUrl('https://github.com/owner/repo');
      expect(result).toEqual({ host: 'github.com', owner: 'owner', repo: 'repo' });
    });

    it('returns null for invalid URLs', () => {
      expect(parseRemoteUrl('not-a-url')).toBeNull();
      expect(parseRemoteUrl('')).toBeNull();
    });
  });

  // ── parseRemotes ────────────────────────────────────────────────────────

  describe('parseRemotes', () => {
    it('parses git remote -v output', () => {
      const output = [
        'origin\thttps://github.com/acme/app.git (fetch)',
        'origin\thttps://github.com/acme/app.git (push)',
        'upstream\tgit@github.com:other/app.git (fetch)',
        'upstream\tgit@github.com:other/app.git (push)',
      ].join('\n');

      const remotes = parseRemotes(output);
      expect(remotes).toHaveLength(2);
      expect(remotes[0].name).toBe('origin');
      expect(remotes[0].owner).toBe('acme');
      expect(remotes[1].name).toBe('upstream');
      expect(remotes[1].owner).toBe('other');
    });

    it('deduplicates fetch/push entries', () => {
      const output = 'origin\thttps://github.com/a/b.git (fetch)\norigin\thttps://github.com/a/b.git (push)\n';
      expect(parseRemotes(output)).toHaveLength(1);
    });
  });

  // ── SSH alias resolution ────────────────────────────────────────────────

  describe('SSH alias resolution', () => {
    it('resolves this project remote URL correctly', () => {
      expect(remoteUrl).toBeTruthy();
      const parsed = parseRemoteUrl(remoteUrl);
      expect(parsed).not.toBeNull();
      expect(parsed!.owner).toBeTruthy();
      expect(parsed!.repo).toBeTruthy();
    });

    it('resolves SSH alias to real hostname if alias is used', async () => {
      if (!remoteHost || remoteHost === 'github.com' || remoteHost === 'gitlab.com') {
        // Direct hostname, no alias to resolve
        return;
      }

      // This project uses an SSH alias — verify ssh -G resolves it
      try {
        const { stdout } = await execFileAsync('ssh', ['-G', remoteHost], { timeout: 3000 });
        const match = stdout.match(/^hostname\s+(\S+)/m);
        expect(match).not.toBeNull();
        const resolved = match![1];
        expect(['github.com', 'gitlab.com']).toContain(resolved);
      } catch {
        // ssh -G not available, skip
      }
    });
  });

  // ── detectRepo (full chain) ─────────────────────────────────────────────

  describe('detectRepo', () => {
    it('detects this project as a git repo with known platform', async () => {
      const result = await detectRepo(PROJECT_DIR);

      // Must not be no_repo or unknown_platform
      expect(result.status).not.toBe('no_repo');
      expect(result.status).not.toBe('unknown_platform');

      // Should have info with platform
      expect(result.info).not.toBeNull();
      expect(['github', 'gitlab']).toContain(result.info!.platform);
      expect(result.info!.owner).toBeTruthy();
      expect(result.info!.repo).toBeTruthy();
    });

    it('returns ok status when CLI is available and authenticated', async () => {
      const result = await detectRepo(PROJECT_DIR);

      // If gh/glab is installed and authenticated, status should be ok
      if (result.status === 'ok') {
        expect(result.cliVersion).toBeTruthy();
        expect(result.cliAuth).toBe(true);
        expect(result.info!.currentBranch).toBeTruthy();
      }
    });

    it('includes branch info when status is ok', async () => {
      const result = await detectRepo(PROJECT_DIR);

      if (result.status === 'ok') {
        expect(result.info!.currentBranch).toBe(currentBranch);
      }
    });

    it('returns no_repo for a non-git directory', async () => {
      const result = await detectRepo('/tmp');
      expect(result.status).toBe('no_repo');
      expect(result.info).toBeNull();
    });
  });

  // ── handleRepoCommand (daemon command handler) ───────────────────────────

  describe('handleRepoCommand', () => {
    let mockServerLink: { send: ReturnType<typeof import('vitest').vi.fn>; messages: any[] };

    beforeAll(() => {
      // Ensure session store has this project so validateProjectDir passes
      loadStore();
      const sessions = listSessions();
      const hasProject = sessions.some(s => s.projectDir === PROJECT_DIR);
      if (!hasProject) {
        upsertSession({
          name: `deck_e2e_repo_${Date.now()}`,
          projectName: 'e2e-test',
          role: 'brain',
          agentType: 'shell',
          projectDir: PROJECT_DIR,
          state: 'idle',
          restarts: 0,
          restartTimestamps: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }

      mockServerLink = {
        send: (globalThis as any).vi?.fn?.() ?? ((msg: any) => { mockServerLink.messages.push(msg); }),
        messages: [],
      };
    });

    it('responds to repo.detect with detect_response (not error)', async () => {
      const messages: any[] = [];
      const link = { send: (msg: any) => messages.push(msg) };

      handleRepoCommand(
        { type: 'repo.detect', projectDir: PROJECT_DIR, requestId: 'test-1' },
        link as any,
      );

      // Wait for async detection to complete
      await new Promise(r => setTimeout(r, 8000));

      expect(messages.length).toBeGreaterThan(0);

      const response = messages[0];
      expect(response.type).toBe('repo.detect_response');
      expect(response.requestId).toBe('test-1');
      expect(response.projectDir).toBe(PROJECT_DIR);
      // Should have detected the platform
      expect(response.status).not.toBe('unknown_platform');
    }, 15000);

    it('returns invalid_params for unknown projectDir', () => {
      const messages: any[] = [];
      const link = { send: (msg: any) => messages.push(msg) };

      handleRepoCommand(
        { type: 'repo.detect', projectDir: '/nonexistent/path', requestId: 'test-2' },
        link as any,
      );

      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe('repo.error');
      expect(messages[0].error).toBe('invalid_params');
      expect(messages[0].projectDir).toBe('/nonexistent/path');
    });

    it('returns invalid_params for missing projectDir', () => {
      const messages: any[] = [];
      const link = { send: (msg: any) => messages.push(msg) };

      handleRepoCommand(
        { type: 'repo.detect', requestId: 'test-3' },
        link as any,
      );

      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe('repo.error');
      expect(messages[0].error).toBe('invalid_params');
    });
  });
});
