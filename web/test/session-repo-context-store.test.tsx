/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, cleanup } from '@testing-library/preact';
import {
  __resetSessionRepoContextStoreForTests,
  getSessionRepoContext,
  ingestSessionRepoContext,
} from '../src/session-repo-context-store.js';
import { SessionRepoBranchSummary } from '../src/components/SessionRepoBranchSummary.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'repo.branch_summary_title') return `Current branch: ${opts?.branch}`;
      if (key === 'repo.branch_summary_label') return `Open repository information for branch ${opts?.branch}`;
      const map: Record<string, string> = {
        'repo.info_title': 'Repository information',
        'repo.info_current_branch': 'Branch',
        'repo.info_project_dir': 'Project',
        'repo.info_repository': 'Repository',
        'repo.info_provider': 'Provider',
        'repo.info_default_branch': 'Default',
      };
      return map[key] ?? key;
    },
  }),
}));

describe('session repo context store and summary', () => {
  beforeEach(() => {
    cleanup();
    __resetSessionRepoContextStoreForTests();
  });

  it('preserves daemon-shaped currentBranch and rejects older generations', () => {
    expect(ingestSessionRepoContext({
      sessionId: 'deck_proj_brain',
      projectDir: '/repo/project',
      context: {
        status: 'ok',
        info: { platform: 'github', owner: 'acme', repo: 'widgets', currentBranch: 'feature/a' },
        repoGeneration: 20,
        detectedAt: 2000,
      },
    })).toBe(true);
    expect(getSessionRepoContext('deck_proj_brain', '/repo/project')?.currentBranch).toBe('feature/a');

    expect(ingestSessionRepoContext({
      sessionId: 'deck_proj_brain',
      projectDir: '/repo/project',
      context: {
        status: 'ok',
        info: { platform: 'github', owner: 'acme', repo: 'widgets', currentBranch: 'old' },
        repoGeneration: 19,
        detectedAt: 3000,
      },
    })).toBe(false);
    expect(getSessionRepoContext('deck_proj_brain', '/repo/project')?.currentBranch).toBe('feature/a');
  });

  it('uses the newest project generation across exact session and project-wide entries', () => {
    ingestSessionRepoContext({
      sessionId: 'deck_proj_brain',
      projectDir: '/repo/project',
      context: {
        status: 'ok',
        info: { currentBranch: 'main' },
        repoGeneration: 10,
        detectedAt: 1000,
      },
    });

    expect(ingestSessionRepoContext({
      projectDir: '/repo/project',
      context: {
        status: 'ok',
        info: { currentBranch: 'feature/a' },
        repoGeneration: 11,
        detectedAt: 1100,
      },
    })).toBe(true);

    expect(getSessionRepoContext('deck_proj_brain', '/repo/project')?.currentBranch).toBe('feature/a');
  });

  it('rejects session-specific updates that are older than project-wide context', () => {
    ingestSessionRepoContext({
      projectDir: '/repo/project',
      context: {
        status: 'ok',
        info: { currentBranch: 'feature/a' },
        repoGeneration: 20,
        detectedAt: 2000,
      },
    });

    expect(ingestSessionRepoContext({
      sessionId: 'deck_proj_brain',
      projectDir: '/repo/project',
      context: {
        status: 'ok',
        info: { currentBranch: 'main' },
        repoGeneration: 19,
        detectedAt: 3000,
      },
    })).toBe(false);

    expect(getSessionRepoContext('deck_proj_brain', '/repo/project')?.currentBranch).toBe('feature/a');
  });

  it('renders a branch-only compact summary and opens repo info on click', () => {
    ingestSessionRepoContext({
      sessionId: 'deck_proj_brain',
      projectDir: '/repo/project',
      context: {
        status: 'ok',
        info: {
          platform: 'github',
          owner: 'acme',
          repo: 'widgets',
          defaultBranch: 'main',
          currentBranch: 'feature/a',
        },
        repoGeneration: 1,
        detectedAt: 1000,
      },
    });

    render(<SessionRepoBranchSummary sessionId="deck_proj_brain" projectDir="/repo/project" />);
    expect(screen.getByRole('button', { name: 'Open repository information for branch feature/a' })).toBeDefined();
    expect(screen.getByText('feature/a')).toBeDefined();
    expect(screen.queryByText('acme/widgets')).toBeNull();
    expect(screen.queryByText('main')).toBeNull();

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Repository information')).toBeDefined();
    expect(screen.getByText('acme/widgets')).toBeDefined();
    expect(screen.getByText('main')).toBeDefined();
  });

  it('delegates click to repo panel opener when provided', () => {
    const onOpenRepo = vi.fn();
    ingestSessionRepoContext({
      sessionId: 'deck_proj_brain',
      projectDir: '/repo/project',
      context: { status: 'ok', info: { currentBranch: 'main' }, repoGeneration: 1 },
    });
    render(<SessionRepoBranchSummary sessionId="deck_proj_brain" projectDir="/repo/project" onOpenRepo={onOpenRepo} />);

    fireEvent.click(screen.getByRole('button'));
    expect(onOpenRepo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Repository information')).toBeNull();
  });
});
