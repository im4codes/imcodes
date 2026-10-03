import { describe, expect, it } from 'vitest';
import {
  generateTaskPairTitle,
  TASK_PAIR_GENERATED_TITLE_MAX_CHARS,
  type GenerateTaskPairTitleOptions,
} from '../../../src/daemon/task-pairs/title-generator.js';

type QueryImpl = NonNullable<GenerateTaskPairTitleOptions['queryImpl']>;

describe('generateTaskPairTitle', () => {
  it('runs an isolated no-tools query naming the target locale, and bounds the result', async () => {
    let captured: Parameters<QueryImpl>[0] | undefined;
    const queryImpl: QueryImpl = (input) => {
      captured = input;
      const iterable = (async function* () {
        yield {
          type: 'result', subtype: 'success', is_error: false,
          structured_output: { title: 'This is a way too long generated title that must be truncated' },
        } as never;
      })();
      return Object.assign(iterable, { close: () => {} });
    };
    const title = await generateTaskPairTitle('Fix the login bug for SSO users.', 'zh-CN', { queryImpl });
    expect(title?.length).toBeLessThanOrEqual(TASK_PAIR_GENERATED_TITLE_MAX_CHARS);
    expect(captured?.prompt).toContain('Simplified Chinese');
    expect(captured?.prompt).toContain('Fix the login bug for SSO users.');
    expect(captured?.options).toMatchObject({
      maxTurns: 1, tools: [], allowedTools: [], persistSession: false, permissionMode: 'dontAsk',
      outputFormat: { type: 'json_schema' },
    });
  });

  it('returns undefined for empty input without calling the query', async () => {
    let called = false;
    const queryImpl: QueryImpl = () => { called = true; return (async function* () {})() as never; };
    const title = await generateTaskPairTitle('   ', 'en', { queryImpl });
    expect(title).toBeUndefined();
    expect(called).toBe(false);
  });

  it('returns undefined (never throws) when the query fails or times out', async () => {
    const queryImpl: QueryImpl = () => {
      const iterable = (async function* () {
        yield { type: 'result', subtype: 'error_max_turns', is_error: true } as never;
      })();
      return Object.assign(iterable, { close: () => {} });
    };
    const title = await generateTaskPairTitle('Some brief.', 'en', { queryImpl, timeoutMs: 5_000 });
    expect(title).toBeUndefined();
  });
});
