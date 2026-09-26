/**
 * Generates a short, localized task-pair title from an objective/brief when
 * no one gave an explicit one. Reuses the isolated one-shot Claude query
 * harness (src/agent/isolated-claude-query.ts, the same mechanism the
 * capability auditor uses) instead of a live agent session: cheap, bounded,
 * and safe to run as fire-and-forget background work off the marker path.
 *
 * The language comes from the project Brain's `uiLocale` (the same field the
 * retired legacy supervision prompts used for
 * `SUPERVISION_TASK_DISPLAY_LANGUAGE_RULE` -- see shared/supervision-config.ts)
 * so a title is written in the language the user picked in the web UI, not
 * whatever language the objective/brief happened to be authored in.
 */
import {
  runIsolatedClaudeQuery,
  type IsolatedClaudeQueryImplementation,
} from '../../agent/isolated-claude-query.js';
import { SUPERVISION_OUTPUT_LANGUAGE_LABELS, type SupervisionUiLocale } from '../../../shared/supervision-config.js';
import { readSupervisionTaskTitle } from '../../../shared/supervision-task-identity.js';
import logger from '../../util/logger.js';

/** Longest title this generator will hand back; the mechanical fallback (shared/supervision-task-identity.ts) allows much longer text. */
export const TASK_PAIR_GENERATED_TITLE_MAX_CHARS = 30;
export const TASK_PAIR_TITLE_GENERATION_TIMEOUT_MS = 20_000;

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
