import { redactSensitiveText } from './redact-secrets.js';

const PINNED_HEADING_RE = /^##\s+User-Pinned Notes\s*$/m;
const NEXT_HEADING_RE = /^##\s+/m;

function findPinnedRegion(summary: string): { start: number; contentStart: number; end: number } | undefined {
  const match = PINNED_HEADING_RE.exec(summary);
  if (!match) return undefined;
  const headingEnd = match.index + match[0].length;
  const contentStart = summary[headingEnd] === '\r' && summary[headingEnd + 1] === '\n'
    ? headingEnd + 2
    : summary[headingEnd] === '\n'
      ? headingEnd + 1
      : headingEnd;
  const rest = summary.slice(contentStart);
  const next = NEXT_HEADING_RE.exec(rest);
  return {
    start: match.index,
    contentStart,
    end: next ? contentStart + next.index : summary.length,
  };
}

export function redactSummaryPreservingPinned(summary: string, extraPatterns: RegExp[] = []): string {
  const region = findPinnedRegion(summary);
  if (!region) return redactSensitiveText(summary, extraPatterns);

  return redactWithProtectedRange(summary, region.contentStart, region.end, extraPatterns);
}

export function ensurePinnedNotesSection(
  summary: string,
  pinnedNotes: readonly string[] = [],
  extraPatterns: RegExp[] = [],
): string {
  const nonEmptyPinned = pinnedNotes.filter((note) => note.length > 0);
  if (nonEmptyPinned.length === 0) {
    return redactSummaryPreservingPinned(summary, extraPatterns);
  }

  const pinnedBlock = `${nonEmptyPinned.join('\n')}\n\n`;
  const region = findPinnedRegion(summary);
  if (region) {
    const before = summary.slice(0, region.contentStart);
    const repaired = `${before}${pinnedBlock}${summary.slice(region.end).replace(/^\n+/, '')}`;
    return redactWithProtectedRange(repaired, before.length, before.length + pinnedBlock.length, extraPatterns);
  }

  const before = `${summary.trimEnd()}\n\n## User-Pinned Notes\n`;
  const repaired = `${before}${pinnedBlock}`;
  return redactWithProtectedRange(repaired, before.length, before.length + pinnedBlock.length, extraPatterns);
}

function redactWithProtectedRange(summary: string, start: number, end: number, extraPatterns: RegExp[]): string {
  const before = summary.slice(0, start);
  const protectedText = summary.slice(start, end);
  const after = summary.slice(end);
  return `${redactSensitiveText(before, extraPatterns)}${protectedText}${redactSensitiveText(after, extraPatterns)}`;
}
