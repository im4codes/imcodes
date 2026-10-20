import { describe, expect, it } from 'vitest';
import en from '../src/i18n/locales/en.json';
import es from '../src/i18n/locales/es.json';
import ja from '../src/i18n/locales/ja.json';
import ko from '../src/i18n/locales/ko.json';
import ru from '../src/i18n/locales/ru.json';
import zhCN from '../src/i18n/locales/zh-CN.json';
import zhTW from '../src/i18n/locales/zh-TW.json';

const screenshotKeys = [
  'current_version',
  'latest_version',
  'connection_status',
  'not_connected',
  'show_controls',
  'hide_controls',
  'pause',
  'resume',
  'disconnect',
  'stop_all',
  'upgrade_retrying',
  'upgrade_failed',
  'upgrade_failed_reason',
  'upgrade_permission_required',
  'upgrade_status_pending_offline',
  'upgrade_status_pending_publication',
  'upgrade_status_sent',
  'upgrade_status_terminal_blocked',
  'upgrade_status_superseded',
] as const;

describe('controlled-node remote desktop locale coverage', () => {
  it('keeps screenshot controls present and translated in every locale', () => {
    const locales = [zhCN, zhTW, es, ru, ja, ko];
    for (const locale of locales) {
      for (const key of screenshotKeys) {
        const value = locale.controlled_nodes[key];
        expect(value, `${key} must be a non-empty translation`).toEqual(expect.any(String));
        expect(value.trim()).not.toBe('');
        expect(value).not.toBe(en.controlled_nodes[key]);
      }
    }
  });

  it('uses the intended Chinese labels for the screenshot path', () => {
    expect(zhCN.controlled_nodes).toMatchObject({
      current_version: '当前',
      latest_version: '最新',
      connection_status: '连接',
      not_connected: '未连接',
      show_controls: '控件',
      hide_controls: '隐藏控件',
      stop_all: '停止全部',
      upgrade_status_pending_offline: '等待节点',
    });
  });

  it('keeps interpolation placeholders intact for translated controlled-node labels', () => {
    const tokenPattern = /\{\{[^}]+\}\}/g;
    const locales = [zhCN, zhTW, es, ru, ja, ko];
    for (const locale of locales) {
      for (const key of Object.keys(en.controlled_nodes)) {
        const englishValue = en.controlled_nodes[key];
        const translatedValue = locale.controlled_nodes[key];
        if (typeof englishValue !== 'string' || typeof translatedValue !== 'string') continue;
        const englishTokens = englishValue.match(tokenPattern) ?? [];
        const translatedTokens = translatedValue.match(tokenPattern) ?? [];
        expect(translatedTokens, `${key} interpolation tokens`).toEqual(englishTokens);
      }
    }
  });
});
