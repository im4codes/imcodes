export type ToolCompressor = (content: string, eventId: string, maxChars: number) => string;

function placeholder(eventId: string, originalChars: number, retainedChars = 0): string {
  const omitted = Math.max(0, originalChars - retainedChars);
  const kbOmitted = Math.max(1, Math.ceil(omitted / 1024));
  return `[event:${eventId} — ${kbOmitted}KB elided, retrievable via chat_get_event]`;
}

function maybeKeep(content: string, eventId: string, maxChars: number): string {
  return content.length <= maxChars ? content : placeholder(eventId, content.length);
}

function bashCompressor(content: string, eventId: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const lines = content.split('\n').map((line) => line.trimEnd()).filter(Boolean);
  const interesting = lines.filter((line) => {
    const normalized = line.trimStart();
    return /^(On branch|Changes|Untracked files|modified:|new file:|deleted:|renamed:|\?\?|[MADRCU]\s+)/.test(normalized)
      || /error|failed|fatal|warning/i.test(line);
  }).map((line) => line.trimStart()).slice(0, 20);
  if (interesting.length > 0) {
    return [`Bash output summary (${lines.length} lines):`, ...interesting, placeholder(eventId, content.length, interesting.join('\n').length)].join('\n');
  }
  return placeholder(eventId, content.length);
}

function readCompressor(content: string, eventId: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const firstLine = content.split('\n')[0]?.slice(0, 200) ?? '';
  return [`Read output elided${firstLine ? `: ${firstLine}` : ''}`, placeholder(eventId, content.length, firstLine.length)].join('\n');
}

function editCompressor(content: string, eventId: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const lines = content.split('\n');
  const summary = lines.filter((line) => /^(\+\+\+|---|@@|[+-](?![+-]))/.test(line)).slice(0, 40).join('\n');
  return summary ? `${summary}\n${placeholder(eventId, content.length, summary.length)}` : placeholder(eventId, content.length);
}

function grepCompressor(content: string, eventId: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const lines = content.split('\n').filter(Boolean);
  const head = lines.slice(0, 30).join('\n');
  return `Grep results (${lines.length} matches, first ${Math.min(30, lines.length)}):\n${head}\n${placeholder(eventId, content.length, head.length)}`;
}

function globCompressor(content: string, eventId: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const lines = content.split('\n').filter(Boolean);
  const head = lines.slice(0, 50).join('\n');
  return `Glob results (${lines.length} paths, first ${Math.min(50, lines.length)}):\n${head}\n${placeholder(eventId, content.length, head.length)}`;
}

function writeCompressor(content: string, eventId: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const firstLine = content.split('\n')[0]?.slice(0, 200) ?? '';
  return `Write output elided${firstLine ? `: ${firstLine}` : ''}\n${placeholder(eventId, content.length, firstLine.length)}`;
}

export const TOOL_COMPRESSORS: Record<string, ToolCompressor> = {
  Bash: bashCompressor,
  Read: readCompressor,
  Edit: editCompressor,
  Grep: grepCompressor,
  Glob: globCompressor,
  Write: writeCompressor,
};

export function compressToolEvent(toolName: string | undefined, content: string, eventId: string, maxChars: number): string {
  const compressor = toolName ? TOOL_COMPRESSORS[toolName] : undefined;
  if (compressor) return compressor(content, eventId, maxChars);
  return maybeKeep(content, eventId, maxChars);
}
