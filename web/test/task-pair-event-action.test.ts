import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInstance } from 'i18next';
import { taskPairEventAction } from '../src/task-pair-event-action.js';
import { TASK_PAIR_VERBS, TASK_PAIR_RECORDED_EVENT_VERBS, TASK_PAIR_WORKSPACE_EFFECTS } from '../../shared/task-pair.js';

for (const locale of ['en', 'zh-CN', 'zh-TW', 'es', 'ru', 'ja', 'ko']) {
  describe(`concrete actions with real ${locale} translations`, () => {
    const root = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');
    const translation = JSON.parse(readFileSync(join(root, 'src/i18n/locales', `${locale}.json`), 'utf8'));
    const i18n = createInstance();
    void i18n.init({ lng: locale, resources: { [locale]: { translation } }, initImmediate: false });
    const t = (key: string, opts?: Record<string, unknown>) => String(i18n.t(key, opts));
    it.each([...TASK_PAIR_VERBS, ...TASK_PAIR_RECORDED_EVENT_VERBS, 'TITLE', 'MATERIAL', 'CHECKLIST_AUTO_TICK', 'NOTICE', 'PAIR_DISPATCH', 'PAIR_DELIVERY', 'BRAIN_NOTICE'])('translates known %s without raw keys', (verb) => {
      const action = taskPairEventAction(t, { verb });
      expect(action?.label).toBeTruthy();
      expect(action?.label).not.toMatch(/taskPair\.|undefined/);
      expect(action?.label).not.toBe(translation.taskPair.verb.other);
    });
    it.each(Object.values(TASK_PAIR_WORKSPACE_EFFECTS))('translates workspace %s without inferring removal', (effect) => {
      const action = taskPairEventAction(t, { verb: 'WORKSPACE', effect });
      expect(action?.label).toBeTruthy();
      expect(action?.label).not.toMatch(/taskPair\.|undefined/);
      if (effect !== TASK_PAIR_WORKSPACE_EFFECTS.REMOVED) expect(action?.label).not.toBe(translation.taskPair.workspace_removed);
    });
    it('keeps feedback/request neutral and never derives actions from free text or state', () => {
      expect(taskPairEventAction(t, { verb: 'DECISION_REQUEST' })?.label).toBe(translation.taskPair.verb.decision_request);
      expect(taskPairEventAction(t, { verb: 'FUTURE', toStatus: 'passed' })).toBeUndefined();
      expect(taskPairEventAction(t, { verb: 'WORKSPACE', effect: 'REMOVED because success' })).toBeUndefined();
    });
  });
}
