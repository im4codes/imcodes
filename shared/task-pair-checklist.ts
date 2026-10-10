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
  let fenced = false;
  let fenceChar = '';
  markdown.split(/\r?\n/u).forEach((line, lineIndex) => {
    const fence = line.match(/^\s*(`{3,}|~{3,})/u);
    if (fence) {
      const char = fence[1]![0]!;
      if (!fenced) { fenced = true; fenceChar = char; }
      else if (char === fenceChar) fenced = false;
      return;
    }
    if (fenced) return;
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
