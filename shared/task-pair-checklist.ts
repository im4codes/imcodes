export interface TaskPairChecklistItem {
  index: number;
  line: number;
  text: string;
  implemented: boolean;
  audited: boolean;
  hasAuditBox: boolean;
}

const CHECKLIST_RE = /^(\s*-\s+)\[([ xX])\](?:\[([ xX])\])?\s+(.*)$/u;

export function parseTaskPairChecklist(markdown: string): TaskPairChecklistItem[] {
  const items: TaskPairChecklistItem[] = [];
  let fenceChar = '';
  let fenceLen = 0;
  markdown.split(/\r?\n/u).forEach((line, lineIndex) => {
    if (fenceLen > 0) {
      const closeFence = line.match(/^\s*(`{3,}|~{3,})\s*$/u);
      if (closeFence && closeFence[1]![0] === fenceChar && closeFence[1]!.length >= fenceLen) {
        fenceChar = '';
        fenceLen = 0;
      }
      return;
    }
    const openFence = line.match(/^\s*(`{3,}|~{3,})(.*)$/u);
    if (openFence) {
      const char = openFence[1]![0]!;
      // CommonMark: backtick fence info strings cannot contain backticks (those are inline code).
      if (!(char === '`' && openFence[2]!.includes('`'))) {
        fenceChar = char;
        fenceLen = openFence[1]!.length;
        return;
      }
    }
    const match = line.match(CHECKLIST_RE);
    if (!match) return;
    items.push({
      index: items.length + 1,
      line: lineIndex,
      text: match[4]!,
      implemented: match[2]!.toLowerCase() === 'x',
      audited: (match[3] ?? '').toLowerCase() === 'x',
      hasAuditBox: match[3] !== undefined,
    });
  });
  return items;
}

export function hasAuditedPairChecklistItem(markdown: string): boolean {
  return parseTaskPairChecklist(markdown).some(
    (item) => item.hasAuditBox && !item.implemented && !item.audited && item.text.trim().length > 0,
  );
}

export function taskPairChecklistCounts(markdown: string): { total: number; implemented: number; audited: number } {
  const items = parseTaskPairChecklist(markdown);
  return { total: items.length, implemented: items.filter((item) => item.implemented).length, audited: items.filter((item) => item.audited).length };
}

export function updateTaskPairChecklist(markdown: string, indexes: readonly number[], box: 'implemented' | 'audited', checked: boolean): string {
  const wanted = new Set(indexes);
  if (wanted.size === 0) return markdown;
  const newline = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.split(/\r?\n/u);
  const items = parseTaskPairChecklist(markdown);
  for (const item of items) {
    if (!wanted.has(item.index)) continue;
    const line = lines[item.line]!;
    const match = line.match(CHECKLIST_RE);
    if (!match) continue;
    const mark = checked ? 'x' : ' ';
    const first = box === 'implemented' ? mark : match[2]!;
    const second = box === 'audited' ? mark : (match[3] ?? ' ');
    lines[item.line] = `${match[1]}[${first}]${match[3] !== undefined || box === 'audited' ? `[${second}]` : ''} ${match[4]}`;
  }
  return lines.join(newline);
}
