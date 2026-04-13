/**
 * Tests for file search fzf tiebreakers.
 */
import { describe, it, expect } from 'vitest';
import {
  fileSearchByBasenamePrefix,
  fileSearchByMatchPosFromEnd,
  fileSearchByLengthAsc,
} from '../../src/daemon/command-handler.js';

function entry(item: string, positions: number[]) {
  return { item, positions: new Set(positions) };
}

describe('fileSearchByBasenamePrefix', () => {
  it('prefers filename match over directory match', () => {
    const a = entry('src/hooks.ts', [4, 5, 6, 7, 8]); // "hooks" in basename
    const b = entry('hooks/index.ts', [0, 1, 2, 3, 4]); // "hooks" in directory
    expect(fileSearchByBasenamePrefix(a, b)).toBeLessThan(0);
  });

  it('prefers match closer to start of basename', () => {
    const a = entry('src/hooks.ts', [4, 5, 6, 7, 8]); // starts at basename pos 0
    const b = entry('src/xhooks.ts', [5, 6, 7, 8, 9]); // starts at basename pos 1
    expect(fileSearchByBasenamePrefix(a, b)).toBeLessThan(0);
  });

  it('returns 0 for both directory matches', () => {
    const a = entry('hooks/foo.ts', [0, 1, 2, 3, 4]);
    const b = entry('hooks/bar.ts', [0, 1, 2, 3, 4]);
    expect(fileSearchByBasenamePrefix(a, b)).toBe(0);
  });

  it('handles directory paths (trailing slash)', () => {
    const a = entry('src/hooks/', [4, 5, 6, 7, 8]); // "hooks" is basename
    const b = entry('hooks/data/', [0, 1, 2, 3, 4]); // "hooks" in parent dir
    expect(fileSearchByBasenamePrefix(a, b)).toBeLessThan(0);
  });
});

describe('fileSearchByMatchPosFromEnd', () => {
  it('prefers match closer to end of path', () => {
    const a = entry('src/utils/hooks.ts', [10, 11, 12, 13, 14]); // near end
    const b = entry('hooks/utils/index.ts', [0, 1, 2, 3, 4]); // near start
    expect(fileSearchByMatchPosFromEnd(a, b)).toBeLessThan(0);
  });

  it('equal distance returns 0', () => {
    const a = entry('abc.ts', [3, 4]); // dist = 6-4 = 2
    const b = entry('xyz.ts', [3, 4]); // dist = 6-4 = 2
    expect(fileSearchByMatchPosFromEnd(a, b)).toBe(0);
  });
});

describe('fileSearchByLengthAsc', () => {
  it('prefers shorter paths', () => {
    const a = entry('a.ts', []);
    const b = entry('src/deep/path/a.ts', []);
    expect(fileSearchByLengthAsc(a, b)).toBeLessThan(0);
  });

  it('equal length returns 0', () => {
    const a = entry('ab.ts', []);
    const b = entry('cd.ts', []);
    expect(fileSearchByLengthAsc(a, b)).toBe(0);
  });
});

describe('fzf integration', () => {
  it('finds fuzzy matches with correct ranking', async () => {
    const { Fzf } = await import('fzf');
    const paths = [
      'src/hooks/index.ts',
      'src/hooks.ts',
      'src/components/hooks.tsx',
      'src/utils/useHooks.ts',
      'hooks/',
      'docs/hooks-guide.md',
    ];
    const fzf = new Fzf(paths, {
      fuzzy: 'v2',
      forward: false,
      tiebreakers: [fileSearchByBasenamePrefix, fileSearchByMatchPosFromEnd, fileSearchByLengthAsc],
    });

    const results = fzf.find('hooks').map((r) => r.item);
    expect(results.length).toBeGreaterThan(0);
    // All paths should match
    expect(results).toContain('src/hooks.ts');
    expect(results).toContain('hooks/');
  });

  it('ranks exact basename higher', async () => {
    const { Fzf } = await import('fzf');
    const paths = [
      'very/deep/nested/path/to/tmux.ts',
      'src/agent/tmux.ts',
      'src/agent/tmux-wrapper.ts',
    ];
    const fzf = new Fzf(paths, {
      fuzzy: 'v2',
      forward: false,
      tiebreakers: [fileSearchByBasenamePrefix, fileSearchByMatchPosFromEnd, fileSearchByLengthAsc],
    });

    const results = fzf.find('tmux.ts').map((r) => r.item);
    // Shorter path with exact basename match should rank higher
    expect(results[0]).toBe('src/agent/tmux.ts');
  });

  it('handles case insensitive matching', async () => {
    const { Fzf } = await import('fzf');
    const paths = ['src/ChatView.tsx', 'src/chatview.ts'];
    const fzf = new Fzf(paths, { fuzzy: 'v2', forward: false, casing: 'case-insensitive', tiebreakers: [] });

    const results = fzf.find('chatview').map((r) => r.item);
    expect(results.length).toBe(2);
  });

  it('keeps matching case-insensitive even when query contains uppercase letters', async () => {
    const { Fzf } = await import('fzf');
    const paths = ['src/chatview.ts', 'src/components/chat-tools.ts'];
    const fzf = new Fzf(paths, { fuzzy: 'v2', forward: false, casing: 'case-insensitive', tiebreakers: [] });

    const results = fzf.find('ChatView').map((r) => r.item);
    expect(results).toContain('src/chatview.ts');
  });

  it('matches across path segments', async () => {
    const { Fzf } = await import('fzf');
    const paths = [
      'src/agent/session-manager.ts',
      'src/store/session-store.ts',
      'test/daemon/session.test.ts',
    ];
    const fzf = new Fzf(paths, { fuzzy: 'v2', forward: false, tiebreakers: [] });

    const results = fzf.find('sessman').map((r) => r.item);
    expect(results).toContain('src/agent/session-manager.ts');
  });
});
