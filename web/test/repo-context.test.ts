/**
 * @vitest-environment jsdom
 *
 * Tests for repo context normalization and button visibility.
 * Covers the critical path: daemon sends repo.detected or repo.detect_response →
 * app.tsx normalizes → SubSessionBar gets repoContext with .status at top level.
 */
import { describe, it, expect } from 'vitest';

/**
 * Simulates app.tsx normalization logic (extracted for testability).
 * This MUST match the normalization in app.tsx's message handler.
 */
function normalizeRepoMessage(msg: Record<string, unknown>): Record<string, unknown> | null {
  if (msg.type !== 'repo.detected' && msg.type !== 'repo.detect_response') return null;
  const dir = msg.projectDir as string;
  if (!dir) return null;

  const context = (msg as any).context ?? msg;
  return { ...context, context, projectDir: dir };
}

// ── Normalization Tests ──────────────────────────────────────────────────────

describe('repo context normalization', () => {
  // This is the shape daemon sends from lifecycle.ts on session start
  const REPO_DETECTED_MSG = {
    type: 'repo.detected',
    projectDir: '/home/user/myproject',
    context: {
      status: 'ok',
      info: { platform: 'github', owner: 'acme', repo: 'widgets' },
      cliVersion: '2.50.0',
      cliAuth: true,
    },
  };

  // This is the shape daemon sends from repo-handler.ts on explicit detect request
  // Note: context fields are SPREAD at top level, not nested
  const DETECT_RESPONSE_MSG = {
    type: 'repo.detect_response',
    requestId: 'req-123',
    projectDir: '/home/user/myproject',
    status: 'ok',
    info: { platform: 'github', owner: 'acme', repo: 'widgets' },
    cliVersion: '2.50.0',
    cliAuth: true,
  };

  it('normalizes repo.detected — status at top level', () => {
    const result = normalizeRepoMessage(REPO_DETECTED_MSG);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('ok');
    expect(result!.projectDir).toBe('/home/user/myproject');
  });

  it('normalizes repo.detect_response — status at top level', () => {
    const result = normalizeRepoMessage(DETECT_RESPONSE_MSG);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('ok');
    expect(result!.projectDir).toBe('/home/user/myproject');
  });

  it('normalizes repo.detected — context.status accessible', () => {
    const result = normalizeRepoMessage(REPO_DETECTED_MSG);
    expect((result as any).context.status).toBe('ok');
  });

  it('normalizes repo.detect_response — context.status accessible', () => {
    const result = normalizeRepoMessage(DETECT_RESPONSE_MSG);
    expect((result as any).context.status).toBe('ok');
  });

  it('both shapes produce identical status and info fields', () => {
    const fromDetected = normalizeRepoMessage(REPO_DETECTED_MSG)!;
    const fromResponse = normalizeRepoMessage(DETECT_RESPONSE_MSG)!;

    expect(fromDetected.status).toBe(fromResponse.status);
    expect(fromDetected.projectDir).toBe(fromResponse.projectDir);
    expect((fromDetected as any).info.platform).toBe((fromResponse as any).info.platform);
    expect((fromDetected as any).info.owner).toBe((fromResponse as any).info.owner);
    expect((fromDetected as any).info.repo).toBe((fromResponse as any).info.repo);
  });

  it('handles no_repo status correctly', () => {
    const msg = {
      type: 'repo.detect_response',
      requestId: 'req-456',
      projectDir: '/tmp/no-git',
      status: 'no_repo',
      info: null,
    };
    const result = normalizeRepoMessage(msg);
    expect(result!.status).toBe('no_repo');
  });

  it('handles cli_missing status', () => {
    const msg = {
      type: 'repo.detected',
      projectDir: '/home/user/proj',
      context: { status: 'cli_missing', info: null },
    };
    const result = normalizeRepoMessage(msg);
    expect(result!.status).toBe('cli_missing');
  });

  it('handles unauthorized status', () => {
    const msg = {
      type: 'repo.detect_response',
      requestId: 'req-789',
      projectDir: '/home/user/proj',
      status: 'unauthorized',
      info: { platform: 'github', owner: 'acme', repo: 'secret' },
    };
    const result = normalizeRepoMessage(msg);
    expect(result!.status).toBe('unauthorized');
  });

  it('rejects message without projectDir', () => {
    const msg = { type: 'repo.detected', context: { status: 'ok' } };
    expect(normalizeRepoMessage(msg)).toBeNull();
  });

  it('rejects unrelated message types', () => {
    const msg = { type: 'session_list', projectDir: '/foo' };
    expect(normalizeRepoMessage(msg)).toBeNull();
  });
});

// ── SubSessionBar visibility logic ───────────────────────────────────────────

describe('repo button visibility logic', () => {
  // Extracted from SubSessionBar.tsx line 271
  function isRepoButtonVisible(repoContext: any): boolean {
    return !!(
      repoContext &&
      repoContext.status !== 'no_repo' &&
      repoContext.status !== 'unknown_platform'
    );
  }

  function isRepoButtonDimmed(repoContext: any): boolean {
    return (
      repoContext?.status === 'cli_missing' ||
      repoContext?.status === 'cli_outdated' ||
      repoContext?.status === 'unauthorized'
    );
  }

  it('visible for ok status', () => {
    expect(isRepoButtonVisible({ status: 'ok' })).toBe(true);
    expect(isRepoButtonDimmed({ status: 'ok' })).toBe(false);
  });

  it('hidden for no_repo', () => {
    expect(isRepoButtonVisible({ status: 'no_repo' })).toBe(false);
  });

  it('hidden for unknown_platform', () => {
    expect(isRepoButtonVisible({ status: 'unknown_platform' })).toBe(false);
  });

  it('hidden when repoContext is null/undefined', () => {
    expect(isRepoButtonVisible(null)).toBe(false);
    expect(isRepoButtonVisible(undefined)).toBe(false);
  });

  it('visible but dimmed for cli_missing', () => {
    expect(isRepoButtonVisible({ status: 'cli_missing' })).toBe(true);
    expect(isRepoButtonDimmed({ status: 'cli_missing' })).toBe(true);
  });

  it('visible but dimmed for unauthorized', () => {
    expect(isRepoButtonVisible({ status: 'unauthorized' })).toBe(true);
    expect(isRepoButtonDimmed({ status: 'unauthorized' })).toBe(true);
  });

  it('visible but dimmed for cli_outdated', () => {
    expect(isRepoButtonVisible({ status: 'cli_outdated' })).toBe(true);
    expect(isRepoButtonDimmed({ status: 'cli_outdated' })).toBe(true);
  });

  it('visible for multiple_remotes', () => {
    expect(isRepoButtonVisible({ status: 'multiple_remotes' })).toBe(true);
    expect(isRepoButtonDimmed({ status: 'multiple_remotes' })).toBe(false);
  });

  // Critical: normalized repo.detected message has status at top level
  it('works with normalized repo.detected shape', () => {
    const normalized = normalizeRepoMessage({
      type: 'repo.detected',
      projectDir: '/proj',
      context: { status: 'ok', info: { platform: 'github' } },
    });
    expect(isRepoButtonVisible(normalized)).toBe(true);
  });

  // Critical: normalized repo.detect_response message has status at top level
  it('works with normalized repo.detect_response shape', () => {
    const normalized = normalizeRepoMessage({
      type: 'repo.detect_response',
      requestId: 'r1',
      projectDir: '/proj',
      status: 'ok',
      info: { platform: 'gitlab' },
    });
    expect(isRepoButtonVisible(normalized)).toBe(true);
  });
});
