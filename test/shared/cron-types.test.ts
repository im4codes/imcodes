import { describe, expect, it } from 'vitest';
import { normalizeCronExecutionDetail } from '../../shared/cron-types.js';

describe('normalizeCronExecutionDetail', () => {
  it('recovers the newest snapshot from legacy cumulative streaming history', () => {
    const snapshots = [
      '主人',
      '主人，大头开始',
      '主人，大头开始执行今天',
      '主人，大头开始执行今天的统一追踪。\n先筛',
      '主人，大头开始执行今天的统一追踪。\n先筛一只不重复的新股票。',
    ];

    expect(normalizeCronExecutionDetail(snapshots.join('\n'))).toBe(snapshots.at(-1));
  });

  it('recovers the latest available partial snapshot when the old 4KB cap cut off the final event', () => {
    const snapshots = [
      'The answer',
      'The answer for',
      'The answer for today',
      'The answer for today contains',
      'The answer for today contains the latest partial result',
    ];
    expect(normalizeCronExecutionDetail(snapshots.join('\n'))).toBe(snapshots.at(-1));
  });

  it('does not rewrite ordinary multiline Markdown or short prefix-shaped prose', () => {
    const markdown = '# Result\n\n- first\n- second\n\n```ts\nconst value = 1;\n```';
    const prefixShapedProse = 'Step\nStep one\nStep one complete';
    const longerPrefixExample = 'A longer example\nA longer example one\nA longer example one two\nA longer example one two three';

    expect(normalizeCronExecutionDetail(markdown)).toBe(markdown);
    expect(normalizeCronExecutionDetail(prefixShapedProse)).toBe(prefixShapedProse);
    expect(normalizeCronExecutionDetail(longerPrefixExample)).toBe(longerPrefixExample);
  });
});
