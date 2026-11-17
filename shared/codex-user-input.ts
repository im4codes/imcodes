/** Codex app-server's native question protocol, not an MCP tool schema. */
export const CODEX_USER_INPUT_METHOD = 'item/tool/requestUserInput';
export const CODEX_DEFAULT_USER_INPUT_CONFIG = 'features.default_mode_request_user_input=true';
export const INTERACTIVE_QUESTION_TOOL_NAME = 'AskUserQuestion';
export const CODEX_USER_INPUT_INVALID_PARAMS = -32602;
export const CODEX_USER_INPUT_GUIDANCE = 'When a user decision or clarification is needed, use request_user_input to present the question and choices in the IM.codes question dialog instead of asking only in plain text. Do not ask for confirmation when you can proceed safely without it.';

export interface CodexUserInputQuestion {
  id: string;
  header: string;
  question: string;
  options?: Array<{ label: string; description: string }> | null;
  isOther?: boolean;
  isSecret?: boolean;
}

export interface CodexUserInputResponse {
  answers: Record<string, { answers: string[] }>;
}

/** Reverse AskQuestionDialog's ordered [header] answer format; keep multiline text. */
export function codexUserInputResponse(questions: CodexUserInputQuestion[], answer: string): CodexUserInputResponse {
  let remaining = answer;
  const answers: CodexUserInputResponse['answers'] = Object.create(null);
  for (let i = 0; i < questions.length; i++) {
    const prefix = `[${questions[i].header}] `;
    if (remaining.startsWith(prefix)) remaining = remaining.slice(prefix.length);
    const next = questions[i + 1];
    const boundary = next ? remaining.indexOf(`\n[${next.header}] `) : -1;
    const text = (boundary < 0 ? remaining : remaining.slice(0, boundary)).trim();
    answers[questions[i].id] = { answers: text && text !== 'skip' ? [text] : [] };
    remaining = boundary < 0 ? '' : remaining.slice(boundary + 1);
  }
  return { answers };
}
