import type { CodexStatusSnapshot } from '../../shared/codex-status.js';
import { stripAnsi } from './terminal-parser.js';

const CONTEXT_RE = /Context window:\s*(\d+)%\s+left\s*\(([\d.]+\s*[KkMm]?)\s+used\s*\/\s*([\d.]+\s*[KkMm]?)\)/i;
const FIVE_HOUR_RE = /5h limit:\s*(\d+)%\s+left\s*\((?:resets?|reset)\s+([^)]+)\)/i;
const WEEKLY_RE = /Weekly limit:\s*(\d+)%\s+left\s*\((?:resets?|reset)\s+([^)]+)\)/i;

export function normalizeCodexStatusPaneText(raw: string): string {
  return stripAnsi(raw)
    .replace(/\r/g, '')
    .replace(/[│┃┆┇]/g, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function parseScaledInt(text: string): number | undefined {
  const match = text.trim().match(/^([\d.]+)\s*([KkMm])?$/);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  const suffix = match[2]?.toLowerCase();
  if (suffix === 'm') return Math.round(value * 1_000_000);
  if (suffix === 'k') return Math.round(value * 1_000);
  return Math.round(value);
}

function findLastMatch(lines: string[], pattern: RegExp): RegExpMatchArray | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(pattern);
    if (match) return match;
  }
  return null;
}

export function countCodexStatusMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

export function parseCodexStatusOutput(raw: string): CodexStatusSnapshot | null {
  const lines = normalizeCodexStatusPaneText(raw).split('\n').filter(Boolean);
  if (lines.length === 0) return null;

  const contextMatch = findLastMatch(lines, CONTEXT_RE);
  const fiveHourMatch = findLastMatch(lines, FIVE_HOUR_RE);
  const weeklyMatch = findLastMatch(lines, WEEKLY_RE);
  if (!contextMatch && !fiveHourMatch && !weeklyMatch) return null;

  const snapshot: CodexStatusSnapshot = { capturedAt: Date.now() };
  if (contextMatch) {
    snapshot.contextLeftPercent = Number(contextMatch[1]);
    snapshot.contextUsedTokens = parseScaledInt(contextMatch[2]);
    snapshot.contextWindowTokens = parseScaledInt(contextMatch[3]);
  }
  if (fiveHourMatch) {
    snapshot.fiveHourLeftPercent = Number(fiveHourMatch[1]);
    snapshot.fiveHourResetAt = fiveHourMatch[2].trim();
  }
  if (weeklyMatch) {
    snapshot.weeklyLeftPercent = Number(weeklyMatch[1]);
    snapshot.weeklyResetAt = weeklyMatch[2].trim();
  }
  return snapshot;
}
