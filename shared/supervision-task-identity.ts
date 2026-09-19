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

/**
 * Bound one candidate title: first meaningful line, control characters and
 * runs of whitespace collapsed, cut on a code-point boundary with an ellipsis.
 * Returns undefined when nothing readable remains.
 */
function boundTitle(value: string): string | undefined {
  const line = value
    .split(/\r\n|\r|\n/)
    .map((candidate) => candidate.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim())
    .find((candidate) => candidate.length > 0);
  if (!line) return undefined;
  const codePoints = Array.from(line);
  if (codePoints.length <= SUPERVISION_TASK_TITLE_MAX_CHARS) return line;
  return `${codePoints.slice(0, SUPERVISION_TASK_TITLE_MAX_CHARS - 1).join('').trimEnd()}…`;
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
