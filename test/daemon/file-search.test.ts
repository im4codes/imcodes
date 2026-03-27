/**
 * Tests for file search fuzzy matching and scoring.
 */
import { describe, it, expect } from 'vitest';
import { fileSearchFuzzyMatch, fileSearchScore } from '../../src/daemon/command-handler.js';

describe('fileSearchFuzzyMatch', () => {
  it('empty query matches everything', () => {
    expect(fileSearchFuzzyMatch('anything', '')).toBe(true);
  });

  it('exact match', () => {
    expect(fileSearchFuzzyMatch('hello', 'hello')).toBe(true);
  });

  it('subsequence match', () => {
    expect(fileSearchFuzzyMatch('src/commands', 'scmd')).toBe(true);
    expect(fileSearchFuzzyMatch('src/components', 'scmp')).toBe(true);
  });

  it('first letter of each segment', () => {
    expect(fileSearchFuzzyMatch('session-manager.ts', 'smts')).toBe(true);
  });

  it('non-contiguous chars in order', () => {
    expect(fileSearchFuzzyMatch('abcdef', 'ace')).toBe(true);
    expect(fileSearchFuzzyMatch('abcdef', 'adf')).toBe(true);
  });

  it('fails when chars not in order', () => {
    expect(fileSearchFuzzyMatch('abc', 'cba')).toBe(false);
  });

  it('fails when char missing', () => {
    expect(fileSearchFuzzyMatch('abc', 'abz')).toBe(false);
  });

  it('case insensitive', () => {
    expect(fileSearchFuzzyMatch('ABC', 'abc')).toBe(true);
    expect(fileSearchFuzzyMatch('abc', 'ABC')).toBe(true);
    expect(fileSearchFuzzyMatch('SrcComponents', 'scmp')).toBe(true);
  });

  it('path separator in query', () => {
    expect(fileSearchFuzzyMatch('src/agent/tmux.ts', 'src/tmux')).toBe(true);
    expect(fileSearchFuzzyMatch('src/agent/tmux.ts', 'agent/tmux')).toBe(true);
  });
});

describe('fileSearchScore', () => {
  it('exact basename = 0', () => {
    expect(fileSearchScore('src/agent/tmux.ts', 'tmux.ts', 'tmux.ts')).toBe(0);
  });

  it('basename substring = 1', () => {
    expect(fileSearchScore('src/agent/tmux.ts', 'tmux.ts', 'tmux')).toBe(1);
  });

  it('full path substring = 3', () => {
    // query has no /, so qBase = full query; "agent/tmux" qBase = "tmux" → basename substring = 1
    // Use a query that only matches the full path, not basename alone
    expect(fileSearchScore('src/agent/session.ts', 'session.ts', 'src/agent')).toBe(3);
  });

  it('fuzzy path match = 4', () => {
    // "scmd" fuzzy matches "src/commands" path
    expect(fileSearchScore('src/commands/foo.ts', 'foo.ts', 'scmd')).toBe(4);
  });

  it('fuzzy basename match = 5', () => {
    // "xyzq" only fuzzy matches basename "xayzbqc.ts", not the path "a/xayzbqc.ts"
    // Need a case where path fuzzy fails but basename fuzzy succeeds
    // Actually path fuzzy is checked first and is a superset. Score 5 is only hit
    // when qBase fuzzy matches basename but full q doesn't fuzzy match full path.
    // This happens when query has / making q != qBase
    expect(fileSearchScore('lib/manager.ts', 'manager.ts', 'z/mngr')).toBe(5);
  });

  it('no match = 99', () => {
    expect(fileSearchScore('src/agent/tmux.ts', 'tmux.ts', 'zzz')).toBe(99);
  });

  it('directory matching works', () => {
    // directory "src/components/" should match query "comp"
    expect(fileSearchScore('src/components/', 'components', 'comp')).toBe(1);
  });

  it('directory fuzzy match', () => {
    // "scmp" fuzzy matches "src/components" path
    expect(fileSearchScore('src/components/', 'components', 'scmp')).toBe(4);
  });

  it('scoring priority: exact > substring > path substring > fuzzy > no match', () => {
    const exact = fileSearchScore('test.ts', 'test.ts', 'test.ts');           // 0
    const substring = fileSearchScore('src/test.ts', 'test.ts', 'test');       // 1
    const pathSub = fileSearchScore('src/agent/foo.ts', 'foo.ts', 'src/agent');// 3
    const fuzzyPath = fileSearchScore('src/test/foo.ts', 'foo.ts', 'stf');     // 4
    const noMatch = fileSearchScore('abc.ts', 'abc.ts', 'zzz');               // 99

    expect(exact).toBeLessThan(substring);
    expect(substring).toBeLessThan(pathSub);
    expect(pathSub).toBeLessThan(fuzzyPath);
    expect(fuzzyPath).toBeLessThan(noMatch);
  });
});
