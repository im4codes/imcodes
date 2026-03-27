/**
 * Priority extraction from issue labels.
 * P0/priority:critical → 0, P1/priority:high → 1,
 * P2/priority:medium → 2, P3/priority:low → 3, default → 3
 */
import type { Priority } from './interface.js';

type LabelPattern = { pattern: RegExp; priority: Priority };

const PRIORITY_PATTERNS: LabelPattern[] = [
  { pattern: /^p0$|^priority[:\s-]?critical$/i,  priority: 0 },
  { pattern: /^p1$|^priority[:\s-]?high$/i,      priority: 1 },
  { pattern: /^p2$|^priority[:\s-]?medium$/i,    priority: 2 },
  { pattern: /^p3$|^priority[:\s-]?low$/i,       priority: 3 },
  { pattern: /^critical$|^urgent$/i,              priority: 0 },
  { pattern: /^high$/i,                           priority: 1 },
  { pattern: /^medium$|^normal$/i,               priority: 2 },
  { pattern: /^low$/i,                            priority: 3 },
];

/**
 * Extract priority from a list of labels.
 * Returns the highest priority (lowest number) found.
 * Defaults to 3 (low) if no priority label is found.
 */
export function extractPriority(labels: string[]): Priority {
  let best: Priority = 3;

  for (const label of labels) {
    for (const { pattern, priority } of PRIORITY_PATTERNS) {
      if (pattern.test(label.trim()) && priority < best) {
        best = priority;
      }
    }
  }

  return best;
}

/** Human-readable priority name */
export function priorityName(p: Priority): string {
  return ['critical', 'high', 'medium', 'low'][p] ?? 'low';
}

/** Sort issues by priority (ascending — P0 first) */
export function sortByPriority<T extends { priority: Priority }>(issues: T[]): T[] {
  return [...issues].sort((a, b) => a.priority - b.priority);
}
