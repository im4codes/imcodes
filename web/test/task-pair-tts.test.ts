import { describe, expect, it } from 'vitest';
import { formatTaskPairTtsAnnouncement, type TaskPairTtsTranslate } from '../src/task-pair-tts.js';
import en from '../src/i18n/locales/en.json';
import zhCN from '../src/i18n/locales/zh-CN.json';
import zhTW from '../src/i18n/locales/zh-TW.json';
import ja from '../src/i18n/locales/ja.json';
import ko from '../src/i18n/locales/ko.json';
import es from '../src/i18n/locales/es.json';
import ru from '../src/i18n/locales/ru.json';

type LocaleBundle = Record<string, unknown>;

const LOCALES: Record<string, LocaleBundle> = {
  en,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  ja,
  ko,
  es,
  ru,
};

function makeTranslator(bundle: LocaleBundle): TaskPairTtsTranslate {
  return (key: string, options?: Record<string, unknown>) => {
    const parts = key.split('.');
    let cursor: unknown = bundle;
    for (const part of parts) {
      cursor = cursor && typeof cursor === 'object' ? (cursor as Record<string, unknown>)[part] : undefined;
    }
    let template = typeof cursor === 'string' ? cursor : key;
    if (options) {
      for (const [k, v] of Object.entries(options)) {
        template = template.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
      }
    }
    return template;
  };
}

describe('task-pair-tts localization & lifecycle formatting', () => {
  it('formats lifecycle statuses in all 7 locales without leaking raw tsk_ IDs', () => {
    for (const [locale, bundle] of Object.entries(LOCALES)) {
      const t = makeTranslator(bundle);
      const passed = formatTaskPairTtsAnnouncement(t, {
        taskId: 'tsk_abc12345',
        title: 'Fix login retry',
        verb: 'PASS',
        toStatus: 'passed',
        round: 1,
      });
      expect(passed, `${locale} passed`).not.toBeNull();
      expect(passed!.text).toContain('Fix login retry');
      expect(passed!.text).toContain(t('taskPair.status.passed'));
      expect(passed!.text).not.toContain('tsk_abc12345');

      const rework = formatTaskPairTtsAnnouncement(t, {
        taskId: 'tsk_abc12345',
        title: 'Fix login retry',
        verb: 'REWORK',
        toStatus: 'rework',
        round: 2,
      });
      expect(rework, `${locale} rework`).not.toBeNull();
      expect(rework!.text).toContain(t('taskPair.status.rework_round', { round: 2 }));

      const untitled = formatTaskPairTtsAnnouncement(t, {
        taskId: 'tsk_9999aaaa',
        title: 'tsk_9999aaaa',
        verb: 'DONE',
        toStatus: 'done',
      });
      expect(untitled, `${locale} untitled`).not.toBeNull();
      expect(untitled!.text).toContain(t('taskPair.card_untitled'));
      expect(untitled!.text).not.toContain('tsk_9999aaaa');

      const aggregate = formatTaskPairTtsAnnouncement(t, {
        taskId: '__aggregate__',
        aggregate: true,
        verb: 'WORKING',
        toStatus: 'working',
      });
      expect(aggregate, `${locale} aggregate`).not.toBeNull();
      expect(aggregate!.text).toContain(t('taskPair.card_aggregate_title'));
      expect(aggregate!.text).not.toContain(t('taskPair.card_untitled'));
    }
  });

  it('maps blocked, needs_input, queued, working, in_audit, cancelled, and next_round cleanly', () => {
    const t = makeTranslator(zhCN);

    expect(formatTaskPairTtsAnnouncement(t, { taskId: 'tsk_1', title: '缓存优化', verb: 'DISPATCH' })?.text)
      .toBe('任务「缓存优化」，执行中');
    expect(formatTaskPairTtsAnnouncement(t, { taskId: 'tsk_1', title: '缓存优化', verb: 'QUEUE' })?.text)
      .toBe('任务「缓存优化」，排队中');
    expect(formatTaskPairTtsAnnouncement(t, { taskId: 'tsk_1', title: '缓存优化', verb: 'READY_FOR_AUDIT' })?.text)
      .toBe('任务「缓存优化」，审计中');
    expect(formatTaskPairTtsAnnouncement(t, { taskId: 'tsk_1', title: '缓存优化', verb: 'BLOCKED', toStatus: 'awaiting_brain_decision' })?.text)
      .toBe('任务「缓存优化」，受阻');
    expect(formatTaskPairTtsAnnouncement(t, { taskId: 'tsk_1', title: '缓存优化', verb: 'NEEDS_INPUT', toStatus: 'awaiting_brain_decision' })?.text)
      .toBe('任务「缓存优化」，需要输入');
    expect(formatTaskPairTtsAnnouncement(t, { taskId: 'tsk_1', title: '缓存优化', verb: 'CANCEL', toStatus: 'cancelled' })?.text)
      .toBe('任务「缓存优化」，已取消');
    expect(formatTaskPairTtsAnnouncement(t, { taskId: 'tsk_1', title: '缓存优化', verb: 'NEXT_ROUND', round: 2 })?.text)
      .toBe('任务「缓存优化」，开启下一轮');
  });

  it('ignores internal bookkeeping verbs and produces round-aware cross-source dedup keys', () => {
    const t = makeTranslator(en);
    for (const ignored of ['CHECK', 'CLAIM', 'TITLE', 'MATERIAL', 'CHECKLIST_AUTO_TICK', 'PAIR_DELIVERY', 'PAIR_DISPATCH', 'BRAIN_NOTICE', 'BRIEF_UPDATED', 'SEND']) {
      expect(formatTaskPairTtsAnnouncement(t, { taskId: 'tsk_1', title: 'A', verb: ignored, toStatus: 'working' })).toBeNull();
    }
    expect(formatTaskPairTtsAnnouncement(t, { taskId: 'tsk_1', title: 'A', verb: 'NOTICE' })).toBeNull();

    // Same lifecycle status across DISPATCH, STARTED, and assistant notice collapses
    const kDispatch = formatTaskPairTtsAnnouncement(t, { taskId: 'tsk_1', title: 'A', verb: 'DISPATCH', toStatus: 'working' })?.dedupKey;
    const kStarted = formatTaskPairTtsAnnouncement(t, { taskId: 'tsk_1', title: 'A', verb: 'STARTED' })?.dedupKey;
    const kWorking = formatTaskPairTtsAnnouncement(t, { taskId: 'tsk_1', title: 'A', verb: 'WORKING', toStatus: 'working' })?.dedupKey;
    expect(kDispatch).toBe(kStarted);
    expect(kStarted).toBe(kWorking);

    // Round 1 rework vs Round 2 rework remain distinct
    const r1 = formatTaskPairTtsAnnouncement(t, { taskId: 'tsk_1', title: 'A', verb: 'REWORK', toStatus: 'rework', round: 1 })?.dedupKey;
    const r2 = formatTaskPairTtsAnnouncement(t, { taskId: 'tsk_1', title: 'A', verb: 'REWORK', toStatus: 'rework', round: 2 })?.dedupKey;
    expect(r1).not.toBe(r2);
  });
});
