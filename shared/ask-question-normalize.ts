export const ASK_QUESTION_TOOL_NAMES = ['AskUserQuestion', 'ask_question'] as const;

const ASK_QUESTION_ALIAS_NAMES = new Set([
  'ask_question',
  'ask_user',
  'ask_user_question',
  'request_user_input',
]);

export type AskQuestionToolName = (typeof ASK_QUESTION_TOOL_NAMES)[number];

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestionItem {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: AskOption[];
}

export function canonicalAskQuestionToolName(name: unknown): AskQuestionToolName | null {
  if (typeof name !== 'string') return null;
  let normalized = name.trim();
  if (!normalized) return null;
  // Some ACP builds append inline invocation JSON after the tool title.
  const jsonIdx = normalized.search(/\s*[\[{]/);
  if (jsonIdx >= 0) normalized = normalized.slice(0, jsonIdx).trim();
  // Antigravity ACP prefixes tool titles with "Run " and/or "default_api:".
  normalized = normalized.replace(/^run\s+/i, '').trim();
  normalized = normalized.replace(/^default_api:/i, '').trim();
  if (normalized === 'AskUserQuestion') return 'AskUserQuestion';
  if (ASK_QUESTION_ALIAS_NAMES.has(normalized)) return 'ask_question';
  return null;
}

export function isAskQuestionToolName(name: unknown): boolean {
  return canonicalAskQuestionToolName(name) !== null;
}

export function normalizeAskQuestionsPayload(raw: unknown): AskQuestionItem[] {
  if (!Array.isArray(raw)) return [];
  const normalized: AskQuestionItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const question = typeof record.question === 'string' ? record.question : '';
    if (!question.trim()) continue;
    const header = typeof record.header === 'string' && record.header.trim()
      ? record.header.trim()
      : undefined;
    const multiSelect = typeof record.multiSelect === 'boolean'
      ? record.multiSelect
      : typeof record.is_multi_select === 'boolean'
        ? record.is_multi_select
        : typeof record.multiple === 'boolean'
          ? record.multiple
          : undefined;
    const rawOptions = Array.isArray(record.options)
      ? record.options
      : Array.isArray(record.choices)
        ? record.choices
        : undefined;
    let options: AskOption[] | undefined;
    if (rawOptions) {
      const parsedOptions: AskOption[] = [];
      for (const opt of rawOptions) {
        if (typeof opt === 'string') {
          const label = opt.trim();
          if (label) parsedOptions.push({ label });
          continue;
        }
        if (!opt || typeof opt !== 'object') continue;
        const optRecord = opt as Record<string, unknown>;
        const label = typeof optRecord.label === 'string' ? optRecord.label.trim() : '';
        if (!label) continue;
        const description = typeof optRecord.description === 'string' && optRecord.description.trim()
          ? optRecord.description.trim()
          : undefined;
        parsedOptions.push(description ? { label, description } : { label });
      }
      if (parsedOptions.length > 0) options = parsedOptions;
    }
    normalized.push({
      question,
      ...(header ? { header } : {}),
      ...(multiSelect !== undefined ? { multiSelect } : {}),
      ...(options ? { options } : {}),
    });
  }
  return normalized;
}

/**
 * Parse an ordered `AskQuestionDialog` answer string (`[Header] value\n...`)
 * into per-question answer arrays (splitting multi-select `, ` when applicable
 * and mapping `skip` / empty text to `[]`).
 */
export function parseAskQuestionAnswers(
  questions: ReadonlyArray<{ header?: string; multiSelect?: boolean }>,
  answer: string,
): string[][] {
  let remaining = answer;
  const parsed: string[][] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    const header = typeof q.header === 'string' ? q.header.trim() : '';
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
    if (!text || text === 'skip') {
      parsed.push([]);
    } else if (q.multiSelect) {
      const items = text.split(', ').map((part) => part.trim()).filter(Boolean);
      parsed.push(items);
    } else {
      parsed.push([text]);
    }
    remaining = boundary < 0 ? '' : remaining.slice(boundary + 1);
  }
  return parsed;
}

export function extractAskQuestionsFromToolInput(rawInput: unknown): AskQuestionItem[] {
  let candidate: unknown = rawInput;
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return [];
    try {
      candidate = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  if (!candidate || typeof candidate !== 'object') return [];
  if (Array.isArray(candidate)) {
    return normalizeAskQuestionsPayload(candidate);
  }
  const obj = candidate as Record<string, unknown>;
  if (Array.isArray(obj.questions)) {
    return normalizeAskQuestionsPayload(obj.questions);
  }
  if (typeof obj.question === 'string' && obj.question.trim()) {
    return normalizeAskQuestionsPayload([obj]);
  }
  return [];
}

export function extractAskQuestionsFromToolName(name: unknown): AskQuestionItem[] {
  if (canonicalAskQuestionToolName(name) === null || typeof name !== 'string') return [];
  const objIdx = name.indexOf('{');
  const arrIdx = name.indexOf('[');
  const startIdx = objIdx >= 0 && arrIdx >= 0
    ? Math.min(objIdx, arrIdx)
    : Math.max(objIdx, arrIdx);
  if (startIdx < 0) return [];
  return extractAskQuestionsFromToolInput(name.slice(startIdx));
}

export function extractAskQuestionsFromToolCallPayload(
  payload: Record<string, unknown> | undefined,
  fallbackText?: string,
): AskQuestionItem[] {
  if (!payload || typeof payload !== 'object') {
    return fallbackText ? extractAskQuestionsFromToolInput(fallbackText) : [];
  }
  const hasCallPayloadInput = Object.prototype.hasOwnProperty.call(payload, '_callPayloadInput');
  const candidates: unknown[] = [
    ...(hasCallPayloadInput ? [payload._callPayloadInput] : []),
    payload.input,
    (payload._callDetail as Record<string, unknown> | undefined)?.input,
    (payload.detail as Record<string, unknown> | undefined)?.input,
    (payload._resultDetail as Record<string, unknown> | undefined)?.input,
    (payload._callDetail as Record<string, unknown> | undefined)?.raw,
    (payload.detail as Record<string, unknown> | undefined)?.raw,
    (payload._resultDetail as Record<string, unknown> | undefined)?.raw,
    fallbackText,
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const questions = extractAskQuestionsFromToolInput(candidate);
    if (questions.length > 0) return questions;
  }
  if (typeof payload.tool === 'string') {
    return extractAskQuestionsFromToolName(payload.tool);
  }
  return [];
}

export function resolveAskQuestionEventToolUseId(event: {
  eventId?: string;
  type: string;
  payload?: Record<string, unknown>;
}): string {
  const payload = event.payload;
  if (event.type === 'ask.question') {
    const raw = payload?.toolUseId;
    return typeof raw === 'string' ? raw : String(raw ?? '');
  }
  for (const candidate of [payload?.toolUseId, payload?.toolCallId, payload?.id, event.eventId]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate);
  }
  return '';
}
