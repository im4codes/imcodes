/**
 * The formal identity every supervised dispatch surface shows: a readable
 * task title derived from the registry objective, plus the exact taskId and
 * assignmentId. One producer, shared by the daemon (initial and continuation
 * dispatch bodies, accepted send receipts) and every reader that renders them
 * (live and reloaded dispatch cards), so no surface ever shows a bare id or a
 * title that disagrees with the registry.
 */

/** Longest readable task title any dispatch surface carries. */
export const SUPERVISION_TASK_TITLE_MAX_CHARS = 120;
/** Safety bound for full objectives projected onto human-readable UI surfaces. */
export const SUPERVISION_TASK_OBJECTIVE_MAX_BYTES = 4096;

/** Opens the readable identity header of a supervised dispatch body. */
export const SUPERVISION_TASK_IDENTITY_HEADER_MARKER = '[IM.codes task]' as const;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const SENTENCE_END = /[.!?。！？]/u;
const CJK_SENTENCE_END = /[。！？]/u;
const CJK_CHARACTER = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/u;
const ASCII_WORD_CHARACTER = /[A-Za-z0-9_]/;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Normalize and byte-bound the authoritative full objective once for every
 * live/reloaded UI projection. Newlines are preserved as soft visual breaks.
 */
export function projectSupervisionTaskObjective(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value
    .replace(/\r\n?|\u2028|\u2029/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, ' ')
      .replace(/[^\S\n]+/gu, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  if (!normalized) return undefined;
  if (utf8ByteLength(normalized) <= SUPERVISION_TASK_OBJECTIVE_MAX_BYTES) return normalized;
  let output = '';
  for (const character of normalized) {
    const candidate = `${output}${character}`;
    if (utf8ByteLength(`${candidate}…`) > SUPERVISION_TASK_OBJECTIVE_MAX_BYTES) break;
    output = candidate;
  }
  return output ? `${output}…` : undefined;
}

/**
 * Bound one candidate title: first meaningful line/sentence, whitespace
 * collapsed, then a word boundary where the script has whitespace-delimited
 * words. CJK falls back to a complete code-point boundary. The ellipsis is
 * added only when source text was actually omitted.
 */
function boundTitle(value: string): string | undefined {
  const lines = value
    .split(/\r\n|\r|\n/)
    .map((candidate) => candidate.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/gu, ' ').trim());
  const firstMeaningfulLine = lines.findIndex((candidate) => candidate.length > 0);
  if (firstMeaningfulLine < 0) return undefined;
  const line = lines[firstMeaningfulLine]!;
  const omittedLines = lines.slice(firstMeaningfulLine + 1).some((candidate) => candidate.length > 0);
  if (!line) return undefined;
  const codePoints = Array.from(line);
  const sentenceEnd = codePoints.findIndex((character, index) => SENTENCE_END.test(character)
    && (CJK_SENTENCE_END.test(character)
      || index === codePoints.length - 1
      || /\s/u.test(codePoints[index + 1]!)));
  if (sentenceEnd >= 0) {
    const sentence = codePoints.slice(0, sentenceEnd + 1);
    const shortened = omittedLines || sentenceEnd < codePoints.length - 1;
    if (!shortened && sentence.length <= SUPERVISION_TASK_TITLE_MAX_CHARS) return sentence.join('');
    if (sentence.length < SUPERVISION_TASK_TITLE_MAX_CHARS) return `${sentence.join('')}…`;
  }
  if (codePoints.length <= SUPERVISION_TASK_TITLE_MAX_CHARS) {
    return omittedLines ? `${codePoints.slice(0, SUPERVISION_TASK_TITLE_MAX_CHARS - 1).join('').trimEnd()}…` : line;
  }

  const candidate = codePoints.slice(0, SUPERVISION_TASK_TITLE_MAX_CHARS - 1);
  let contentLength = candidate.length;
  let lastWhitespace = -1;
  for (let index = candidate.length - 1; index >= 0; index -= 1) {
    if (/\s/u.test(candidate[index]!)) {
      lastWhitespace = index;
      break;
    }
  }
  if (lastWhitespace > 0) {
    contentLength = lastWhitespace;
  } else if (!candidate.some((character) => CJK_CHARACTER.test(character))
    && ASCII_WORD_CHARACTER.test(candidate[candidate.length - 1] ?? '')
    && ASCII_WORD_CHARACTER.test(codePoints[candidate.length] ?? '')) {
    // A single overlong ASCII token has no honest word boundary inside the
    // display budget. Showing only an ellipsis is preferable to inventing a
    // chopped identifier that looks authoritative.
    contentLength = 0;
  }
  return `${candidate.slice(0, contentLength).join('').trimEnd()}…`;
}

/** The readable title of a task, derived from its authoritative registry objective. */
export function deriveSupervisionTaskTitle(objective: unknown): string | undefined {
  return typeof objective === 'string' ? boundTitle(objective) : undefined;
}

/**
 * Derive a readable title from a free-form dispatch brief. Dispatch briefs
 * often begin with daemon/role boilerplate; prefer an explicit Title line or
 * an Owner request, then fall back to the first human sentence.
 */
export function deriveSupervisionTaskTitleFromBrief(value: unknown, explicitTitle?: unknown): string | undefined {
  const explicit = readSupervisionTaskTitle(explicitTitle);
  if (explicit) return explicit;
  if (typeof value !== 'string') return undefined;
  const projected = projectSupervisionTaskObjective(value);
  if (!projected) return undefined;
  const lines = projected.split('\n').map((line) => line.trim()).filter(Boolean);
  const titleLine = lines.find((line) => /^title\s*:/iu.test(line));
  if (titleLine) {
    const candidate = titleLine.replace(/^title\s*:\s*/iu, '').trim().replace(/^['"“]|['"”]$/gu, '');
    const title = readSupervisionTaskTitle(candidate);
    if (title) return title;
  }
  const owner = lines.find((line) => /^owner\s+request\s*:/iu.test(line));
  if (owner) {
    const candidate = owner.replace(/^owner\s+request\s*:\s*/iu, '').trim().replace(/^['"“]|['"”]$/gu, '');
    const title = readSupervisionTaskTitle(candidate);
    if (title) return title;
  }
  const boilerplate = /^(?:\[brain\]|\[im\.codes task\]|you are the (?:executor|auditor)\b|repo\s*:|base\s*:|auditor\s*:|executor\s*:|rules?\s*:|process\s*:|phase\s+[a-z]\b|message from im\.codes\b)/iu;
  const candidate = lines.find((line) => !boilerplate.test(line));
  return readSupervisionTaskTitle(candidate ?? lines[0]);
}

/**
 * Read a concise title that crossed a trust boundary (MCP receipt, prompt
 * header metadata). Full human-facing objective surfaces use the separately
 * bounded `projectSupervisionTaskObjective` value.
 */
export function readSupervisionTaskTitle(value: unknown): string | undefined {
  return typeof value === 'string' ? boundTitle(value) : undefined;
}

/**
 * The first lines a recipient reads on every supervised dispatch, initial or
 * continuation: the readable title and the exact authority ids.
 */
export function formatSupervisionTaskIdentityHeader(input: {
  title?: string;
  taskId: string;
  assignmentId: string;
}): string {
  const title = readSupervisionTaskTitle(input.title) ?? '(untitled task)';
  return [
    `${SUPERVISION_TASK_IDENTITY_HEADER_MARKER} ${title}`,
    `taskId: ${input.taskId}`,
    `assignmentId: ${input.assignmentId}`,
  ].join('\n');
}
