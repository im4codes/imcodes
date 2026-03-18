import { describe, it, expect } from 'vitest';
import { extractFromScreenDiff } from '../../src/memory/extractor.js';

describe('extractFromScreenDiff()', () => {
  it('extracts file paths from diff', () => {
    const diff = `
  ● Write file src/auth/middleware.ts
  ● Read file src/config.ts
    `;
    const obs = extractFromScreenDiff(diff, 'deck_test_w1');
    expect(obs.filesModified).toContain('src/auth/middleware.ts');
  });

  it('extracts commands run', () => {
    const diff = `
  $ npm test
  $ git add -A
    `;
    const obs = extractFromScreenDiff(diff, 'deck_test_w1');
    expect(obs.commandsRun.length).toBeGreaterThan(0);
  });

  it('extracts error messages', () => {
    const diff = `
  Error: Cannot find module 'zod'
  error TS2307: Cannot find module './types.js'
    `;
    const obs = extractFromScreenDiff(diff, 'deck_test_w1');
    expect(obs.errors.length).toBeGreaterThan(0);
  });

  it('includes session name', () => {
    const obs = extractFromScreenDiff('some output', 'deck_myproject_w1');
    expect(obs.sessionName).toBe('deck_myproject_w1');
  });

  it('handles empty diff', () => {
    const obs = extractFromScreenDiff('', 'deck_test_w1');
    expect(obs.filesModified).toEqual([]);
    expect(obs.commandsRun).toEqual([]);
    expect(obs.errors).toEqual([]);
  });
});
