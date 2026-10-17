import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = resolve(__dirname, '..');

describe('repeated supervision status translations', () => {
  it('provides count-aware, accessible copy in all seven locales', () => {
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'es', 'ru', 'ja', 'ko']) {
      const json = JSON.parse(readFileSync(
        resolve(WEB_ROOT, `src/i18n/locales/${locale}.json`),
        'utf8',
      ));
      const messages = json.chat.supervision_status_run;
      for (const key of ['heartbeats_one', 'heartbeats_other', 'waiting_one', 'waiting_other']) {
        expect(messages[key], `${locale}.${key}`).toContain('{{count}}');
      }
      expect(messages.expand, `${locale}.expand`).toEqual(expect.any(String));
      expect(messages.collapse, `${locale}.collapse`).toEqual(expect.any(String));
      expect(messages.aria, `${locale}.aria`).toContain('{{status}}');
      expect(messages.aria, `${locale}.aria`).toContain('{{timeRange}}');
      expect(messages.aria, `${locale}.aria`).toContain('{{action}}');
    }
  });
});
