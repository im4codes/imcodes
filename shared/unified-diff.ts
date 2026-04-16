export interface UnifiedDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
}

export type UnifiedDiffLineKind = 'file' | 'hunk' | 'add' | 'del' | 'ctx';

export interface UnifiedDiffParsedLine {
  kind: UnifiedDiffLineKind;
  text: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  hunk?: UnifiedDiffHunk;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: ?(.*))?$/;

export function parseUnifiedDiff(diff: string): UnifiedDiffParsedLine[] {
  const lines = diff.replace(/\r\n/g, '\n').split('\n');
  const parsed: UnifiedDiffParsedLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (i === lines.length - 1 && line === '') continue;
    if (
      line.startsWith('diff ')
      || line.startsWith('index ')
      || line.startsWith('---')
      || line.startsWith('+++')
      || line.startsWith('old mode')
      || line.startsWith('new mode')
    ) {
      parsed.push({ kind: 'file', text: line });
      continue;
    }
    if (line.startsWith('@@')) {
      const match = line.match(HUNK_RE);
      const hunk: UnifiedDiffHunk | undefined = match
        ? {
            oldStart: Number.parseInt(match[1], 10),
            oldLines: Number.parseInt(match[2] ?? '1', 10),
            newStart: Number.parseInt(match[3], 10),
            newLines: Number.parseInt(match[4] ?? '1', 10),
            header: line,
          }
        : undefined;
      if (hunk) {
        oldLine = hunk.oldStart - 1;
        newLine = hunk.newStart - 1;
      }
      parsed.push({ kind: 'hunk', text: line, hunk });
      continue;
    }
    if (line.startsWith('+')) {
      newLine += 1;
      parsed.push({ kind: 'add', text: line.slice(1), newLineNumber: newLine });
      continue;
    }
    if (line.startsWith('-')) {
      oldLine += 1;
      parsed.push({ kind: 'del', text: line.slice(1), oldLineNumber: oldLine });
      continue;
    }
    oldLine += 1;
    newLine += 1;
    parsed.push({
      kind: 'ctx',
      text: line.startsWith(' ') ? line.slice(1) : line,
      oldLineNumber: oldLine,
      newLineNumber: newLine,
    });
  }

  return parsed;
}

export function extractUnifiedDiffHunks(diff: string): UnifiedDiffHunk[] {
  return parseUnifiedDiff(diff)
    .filter((line): line is UnifiedDiffParsedLine & { hunk: UnifiedDiffHunk } => line.kind === 'hunk' && !!line.hunk)
    .map((line) => line.hunk);
}
