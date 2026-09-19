import { describe, expect, it } from 'vitest';

import { SUPERVISION_WAITING_HEARTBEAT_AUTOMATION_KIND } from '../../shared/supervision-config.js';
import {
  localizeSupervisionAutomationNote,
  localizeSupervisionStatusLabel,
} from '../../src/daemon/supervision-i18n.js';

describe('supervision display i18n', () => {
  it.each([
    ['en', 'Auto: parked', 'Supervised: parked'],
    ['zh-CN', '自动：已根据', '监督：等待'],
    ['zh-TW', '自動：已依', '監督：等待'],
    ['es', 'Auto: en espera', 'Supervisión: esperando'],
    ['ru', 'Авто: ожидание', 'Надзор: ожидание'],
    ['ja', '自動：実行', '監督：外部'],
    ['ko', '자동: 실행', '감독: 외부'],
  ] as const)('localizes parked notes and labels for %s', (locale, noteText, statusText) => {
    expect(localizeSupervisionAutomationNote(
      'supervision-parked',
      'Auto: parked on the executing session\'s reported external reply.',
      locale,
    )).toContain(noteText);
    expect(localizeSupervisionStatusLabel(
      'supervision_parked',
      'Supervised: parked until the pending reply arrives.',
      locale,
    )).toContain(statusText);
  });

  it('localizes dynamic heartbeat details without changing the original fallback contract', () => {
    expect(localizeSupervisionAutomationNote(
      SUPERVISION_WAITING_HEARTBEAT_AUTOMATION_KIND,
      'Auto: requested a waiting-status update after 10 minutes; the original deadline was preserved.',
      'zh-CN',
    )).toBe('自动：等待 10 分钟后已请求状态更新；原截止时间不变。');
    expect(localizeSupervisionAutomationNote('unknown-kind', 'raw fallback', 'zh-CN')).toBe('raw fallback');
  });
});
