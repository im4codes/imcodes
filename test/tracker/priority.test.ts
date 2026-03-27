import { describe, it, expect } from 'vitest';
import { extractPriority, priorityName, sortByPriority } from '../../src/tracker/priority.js';

describe('extractPriority', () => {
  it('returns 3 (low) for empty labels', () => {
    expect(extractPriority([])).toBe(3);
  });

  it('returns 3 for unrelated labels', () => {
    expect(extractPriority(['bug', 'feature', 'enhancement'])).toBe(3);
  });

  it('P0 pattern → 0 (critical)', () => {
    expect(extractPriority(['p0'])).toBe(0);
    expect(extractPriority(['P0'])).toBe(0);
    expect(extractPriority(['priority:critical'])).toBe(0);
    expect(extractPriority(['priority-critical'])).toBe(0);
    expect(extractPriority(['critical'])).toBe(0);
    expect(extractPriority(['urgent'])).toBe(0);
  });

  it('P1 pattern → 1 (high)', () => {
    expect(extractPriority(['p1'])).toBe(1);
    expect(extractPriority(['priority:high'])).toBe(1);
    expect(extractPriority(['high'])).toBe(1);
  });

  it('P2 pattern → 2 (medium)', () => {
    expect(extractPriority(['p2'])).toBe(2);
    expect(extractPriority(['priority:medium'])).toBe(2);
    expect(extractPriority(['medium'])).toBe(2);
    expect(extractPriority(['normal'])).toBe(2);
  });

  it('P3 pattern → 3 (low)', () => {
    expect(extractPriority(['p3'])).toBe(3);
    expect(extractPriority(['priority:low'])).toBe(3);
    expect(extractPriority(['low'])).toBe(3);
  });

  it('takes the highest priority (lowest number) from multiple labels', () => {
    expect(extractPriority(['low', 'p1', 'bug'])).toBe(1);
    expect(extractPriority(['p2', 'p0', 'p3'])).toBe(0);
  });

  it('trims whitespace from labels', () => {
    expect(extractPriority([' p0 '])).toBe(0);
  });
});

describe('priorityName', () => {
  it('returns correct names', () => {
    expect(priorityName(0)).toBe('critical');
    expect(priorityName(1)).toBe('high');
    expect(priorityName(2)).toBe('medium');
    expect(priorityName(3)).toBe('low');
  });
});

describe('sortByPriority', () => {
  it('sorts ascending by priority (P0 first)', () => {
    const issues = [
      { priority: 3 as const, title: 'low' },
      { priority: 0 as const, title: 'critical' },
      { priority: 2 as const, title: 'medium' },
      { priority: 1 as const, title: 'high' },
    ];
    const sorted = sortByPriority(issues);
    expect(sorted.map((i) => i.priority)).toEqual([0, 1, 2, 3]);
  });

  it('does not mutate the input array', () => {
    const issues = [{ priority: 3 as const }, { priority: 0 as const }];
    const copy = [...issues];
    sortByPriority(issues);
    expect(issues).toEqual(copy);
  });
});
