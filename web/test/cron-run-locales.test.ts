import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const LOCALES = ['en', 'zh-CN', 'zh-TW', 'es', 'ru', 'ja', 'ko'] as const;
const REQUIRED_KEYS = [
  'aria_label', 'schedule', 'status_dispatched', 'next_run', 'previous_run',
  'show_details', 'hide_details', 'task_body', 'not_available', 'contract_summary',
] as const;
const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('cron run card locale parity', () => {
  it.each(LOCALES)('%s defines every user-visible card label', (locale) => {
    const localePath = resolve(WEB_ROOT, 'src', 'i18n', 'locales', `${locale}.json`);
    const data = JSON.parse(readFileSync(localePath, 'utf8')) as {
      cron?: { run_card?: Record<string, unknown> };
    };
    expect(Object.keys(data.cron?.run_card ?? {}).sort()).toEqual([...REQUIRED_KEYS].sort());
    for (const key of REQUIRED_KEYS) expect(data.cron?.run_card?.[key]).toEqual(expect.any(String));
  });
});
