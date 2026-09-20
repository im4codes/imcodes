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

/** Opens the readable identity header of a supervised dispatch body. */
export const SUPERVISION_TASK_IDENTITY_HEADER_MARKER = '[IM.codes task]' as const;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const SENTENCE_END = /[.!?。！？]/u;
const CJK_SENTENCE_END = /[。！？]/u;
const CJK_CHARACTER = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/u;
const ASCII_WORD_CHARACTER = /[A-Za-z0-9_]/;

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
 * Read a title that crossed a trust boundary (MCP receipt, timeline metadata).
 * The same bound applies, so an oversized or multi-line value can never reach
 * a rendered surface intact.
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
