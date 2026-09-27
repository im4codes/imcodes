/**
 * Shared title validation and localized placeholders.  Pair creation never
 * invokes a provider-side title generator: an untitled pair starts
 * immediately with the placeholder and asks its Brain for a title.  The
 * generator export remains for legacy callers/tests that still use this
 * module directly.
 */
import {
  runIsolatedClaudeQuery,
  type IsolatedClaudeQueryImplementation,
} from '../../agent/isolated-claude-query.js';
import { SUPERVISION_OUTPUT_LANGUAGE_LABELS, type SupervisionUiLocale } from '../../../shared/supervision-config.js';
import { TASK_PAIR_GENERIC_TITLE_PLACEHOLDERS } from '../../../shared/task-pair.js';
import { deriveSupervisionTaskTitleFromBrief, readSupervisionTaskTitle } from '../../../shared/supervision-task-identity.js';
import logger from '../../util/logger.js';

/** Longest title this generator will hand back; the mechanical fallback (shared/supervision-task-identity.ts) allows much longer text. */
export const TASK_PAIR_GENERATED_TITLE_MAX_CHARS = 30;
export const TASK_PAIR_TITLE_GENERATION_TIMEOUT_MS = 20_000;

/** Shown immediately while the localized generator runs; never expose a raw id. */
export const TASK_PAIR_TITLE_PLACEHOLDERS: Record<SupervisionUiLocale, string> = {
  en: 'Untitled task',
  'zh-CN': '未命名任务',
  'zh-TW': '未命名任務',
  es: 'Tarea sin título',
  ru: 'Задача без названия',
  ja: '無題のタスク',
  ko: '제목 없는 작업',
};

export function taskPairTitlePlaceholder(locale: SupervisionUiLocale = 'en'): string {
  return TASK_PAIR_TITLE_PLACEHOLDERS[locale] ?? TASK_PAIR_TITLE_PLACEHOLDERS.en;
}

/**
 * A title is deliberately authored only when it is neither a mechanical
 * identifier/boilerplate nor the first-line projection used by send_message.
 */
export function isUsableTaskPairTitle(
  value: unknown,
  taskId: string,
  sourceText?: string,
  mechanical = false,
): value is string {
  const title = readSupervisionTaskTitle(value);
  if (!title || title === taskId) return false;
  if ((TASK_PAIR_GENERIC_TITLE_PLACEHOLDERS as readonly string[]).includes(title)) return false;
  if (/^brain\s*:/iu.test(title)) return false;
  if (mechanical && sourceText && title === deriveSupervisionTaskTitleFromBrief(sourceText)) return false;
  return true;
}

const TITLE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 80 },
  },
} as const;

function buildTitlePrompt(brief: string, locale: SupervisionUiLocale): string {
  return [
    `Write a short task name (at most ${TASK_PAIR_GENERATED_TITLE_MAX_CHARS} characters) that a person would recognize their own task from, based on the description below.`,
    `Write it in ${SUPERVISION_OUTPUT_LANGUAGE_LABELS[locale]}, regardless of what language the description below is written in.`,
    'Return only the title through the structured field. No surrounding quotes, no trailing period, no explanation.',
    '',
    '<task-description>',
    brief,
    '</task-description>',
  ].join('\n');
}

export interface GenerateTaskPairTitleOptions {
  queryImpl?: IsolatedClaudeQueryImplementation;
  timeoutMs?: number;
  model?: string;
}

let generatorOverride: ((brief: string, locale: SupervisionUiLocale, options?: GenerateTaskPairTitleOptions) => Promise<string | undefined>) | undefined;

/** Test-only override: replaces the isolated-query call with a deterministic stub. */
export function setTaskPairTitleGeneratorForTests(
  fn: ((brief: string, locale: SupervisionUiLocale, options?: GenerateTaskPairTitleOptions) => Promise<string | undefined>) | undefined,
): void {
  generatorOverride = fn;
}

/**
 * Best-effort: returns the generated title, or `undefined` on empty input,
 * timeout, or any query failure. Never throws -- callers keep whatever
 * fallback title they already have.
 */
export async function generateTaskPairTitle(
  brief: string,
  locale: SupervisionUiLocale,
  options: GenerateTaskPairTitleOptions = {},
): Promise<string | undefined> {
  if (generatorOverride) return generatorOverride(brief, locale, options);
  const text = brief.trim();
  if (!text) return undefined;
  try {
    const output = await runIsolatedClaudeQuery({
      prompt: buildTitlePrompt(text, locale),
      outputSchema: TITLE_OUTPUT_SCHEMA,
      timeoutMs: options.timeoutMs ?? TASK_PAIR_TITLE_GENERATION_TIMEOUT_MS,
      ...(options.queryImpl ? { queryImpl: options.queryImpl } : {}),
      ...(options.model ? { model: options.model } : {}),
      label: 'task-pair title generation',
    });
    const title = readSupervisionTaskTitle((output as { title?: unknown } | undefined)?.title);
    return title?.slice(0, TASK_PAIR_GENERATED_TITLE_MAX_CHARS);
  } catch (error) {
    logger.warn({ err: error }, 'task-pair: title generation failed');
    return undefined;
  }
}
