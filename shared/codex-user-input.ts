/** Codex app-server's native question protocol, not an MCP tool schema. */
export const CODEX_USER_INPUT_METHOD = 'item/tool/requestUserInput';
export const CODEX_DEFAULT_USER_INPUT_CONFIG = 'features.default_mode_request_user_input=true';
export const INTERACTIVE_QUESTION_TOOL_NAME = 'AskUserQuestion';
export const CODEX_USER_INPUT_INVALID_PARAMS = -32602;
export const CODEX_USER_INPUT_GUIDANCE = 'When a user decision or clarification is needed, use request_user_input to present the question and choices in the IM.codes question dialog instead of asking only in plain text. Do not ask for confirmation when you can proceed safely without it.';

export interface CodexUserInputQuestion {
  id: string;
  header?: string;
  question: string;
  options?: Array<{ label: string; description: string }> | null;
  isOther?: boolean;
  isSecret?: boolean;
}

export interface CodexAsyncUserInputQuestion {
  title: string;
  options?: string[] | null;
}

export interface NormalizedCodexAsyncQuestion {
  question: string;
  options?: Array<{ label: string }>;
}

export interface CodexUserInputResponse {
  answers: Record<string, { answers: string[] }>;
}

export function normalizeCodexAsyncQuestions(raw: unknown): NormalizedCodexAsyncQuestion[] {
  if (!Array.isArray(raw)) return [];
  const normalized: NormalizedCodexAsyncQuestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const question = typeof record.title === 'string' ? record.title.trim() : '';
    if (!question) continue;
    let options: Array<{ label: string }> | undefined;
    if (Array.isArray(record.options)) {
      const parsed = record.options
        .filter((opt): opt is string => typeof opt === 'string')
        .map((opt) => opt.trim())
        .filter((opt) => opt.length > 0)
        .map((label) => ({ label }));
      if (parsed.length > 0) options = parsed;
    }
    normalized.push({
      question,
      ...(options ? { options } : {}),
    });
  }
  return normalized;
}

/** Reverse AskQuestionDialog's ordered [header] answer format; keep multiline text. */
export function codexUserInputResponse(questions: CodexUserInputQuestion[], answer: string): CodexUserInputResponse {
  let remaining = answer;
  const answers: CodexUserInputResponse['answers'] = Object.create(null);
  for (let i = 0; i < questions.length; i++) {
    const header = typeof questions[i].header === 'string' ? questions[i].header!.trim() : '';
    if (header) {
      const prefix = `[${header}] `;
      if (remaining.startsWith(prefix)) remaining = remaining.slice(prefix.length);
    }
    const next = questions[i + 1];
    const nextHeader = next && typeof next.header === 'string' ? next.header.trim() : '';
    const boundary = next
      ? (nextHeader ? remaining.indexOf(`\n[${nextHeader}] `) : remaining.indexOf('\n'))
      : -1;
    const text = (boundary < 0 ? remaining : remaining.slice(0, boundary)).trim();
    answers[questions[i].id] = { answers: text && text !== 'skip' ? [text] : [] };
    remaining = boundary < 0 ? '' : remaining.slice(boundary + 1);
  }
  return { answers };
}
