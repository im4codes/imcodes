import type { Observation } from './interface.js';

// Patterns to extract file operations from agent screen output
const FILE_PATTERNS = [
  /(?:Created?|Wrote?|Updated?|Modified?|Edited?|Added?|Read|Write|Edit)\s+(?:file\s+)?([\w./\-]+\.\w+)/gi,
  /(?:Deleted?|Removed?)\s+(?:file\s+)?([\w./\-]+\.\w+)/gi,
];

const COMMAND_PATTERN = /^\s*\$\s+(.+)$/gm;
const ERROR_PATTERN = /(?:Error|Exception|Failed|FAILED|error:)\s*(.{0,100})/gi;

export interface ExtractedObservation {
  content: string;
  filesModified: string[];
  commandsRun: string[];
  errors: string[];
  sessionName: string;
}

/**
 * Extract observations from screen content for a given session.
 * @param content - raw screen text to analyze
 * @param sessionName - session identifier included in the result
 */
export function extractFromScreenDiff(content: string, sessionName: string): ExtractedObservation {
  const extracted = extractFromText(content);
  return { ...extracted, sessionName };
}

/**
 * Compute a diff between two screen snapshots and extract observations from new lines.
 */
export function extractDiff(prev: string, current: string, sessionName: string): ExtractedObservation | null {
  const prevLines = new Set(prev.split('\n'));
  const newLines = current.split('\n').filter((l) => !prevLines.has(l) && l.trim().length > 0);
  if (newLines.length === 0) return null;
  return extractFromScreenDiff(newLines.join('\n'), sessionName);
}

export function extractFromText(text: string): ExtractedObservation {
  const filesModified: string[] = [];
  const commandsRun: string[] = [];
  const errors: string[] = [];

  for (const pattern of FILE_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const file = m[1].trim();
      if (!filesModified.includes(file)) filesModified.push(file);
    }
  }

  COMMAND_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COMMAND_PATTERN.exec(text)) !== null) {
    const cmd = m[1].trim();
    if (!commandsRun.includes(cmd)) commandsRun.push(cmd);
  }

  ERROR_PATTERN.lastIndex = 0;
  while ((m = ERROR_PATTERN.exec(text)) !== null) {
    const err = m[0].trim();
    if (!errors.includes(err)) errors.push(err);
  }

  const parts: string[] = [];
  if (filesModified.length > 0) parts.push(`Files: ${filesModified.join(', ')}`);
  if (commandsRun.length > 0) parts.push(`Commands: ${commandsRun.join('; ')}`);
  if (errors.length > 0) parts.push(`Errors: ${errors.join('; ')}`);
  if (parts.length === 0) parts.push(text.slice(0, 200));

  return { content: parts.join(' | '), filesModified, commandsRun, errors, sessionName: '' };
}

export function buildObservation(
  sessionName: string,
  projectName: string,
  extracted: ExtractedObservation,
): Observation {
  return {
    sessionName,
    projectName,
    content: extracted.content,
    timestamp: Date.now(),
    tags: [
      ...(extracted.filesModified.length > 0 ? ['file_change'] : []),
      ...(extracted.commandsRun.length > 0 ? ['command'] : []),
      ...(extracted.errors.length > 0 ? ['error'] : []),
    ],
  };
}
