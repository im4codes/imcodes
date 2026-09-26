import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DAEMON_USER_NOTICE_CODE,
  DAEMON_USER_NOTICE_I18N_KEYS,
  normalizeDaemonUserNoticeParams,
} from '../../shared/daemon-user-notices.js';
import { localizeDaemonUserNoticeEvent } from '../src/daemon-user-notice-i18n.js';
import type { TimelineEvent } from '../../src/shared/timeline/types.js';

const LOCALES = ['en', 'zh-CN', 'zh-TW', 'es', 'ru', 'ja', 'ko'] as const;
const WEB_ROOT = existsSync(resolve(process.cwd(), 'src/i18n/locales'))
  ? process.cwd()
  : resolve(process.cwd(), 'web');

function noticeEvent(code: string, params: Record<string, unknown> = {}): TimelineEvent {
  return {
    id: `notice:${code}`,
    sessionId: 'deck_test',
    seq: 1,
    ts: 1,
    type: 'assistant.text',
    payload: { text: 'English fallback', noticeCode: code, noticeParams: params },
    source: 'daemon',
    confidence: 'high',
  } as TimelineEvent;
}

function resourceTranslator(resource: Record<string, unknown>) {
  return (key: string, options: Record<string, unknown> = {}): string => {
    let value: unknown = resource;
    for (const segment of key.split('.')) value = (value as Record<string, unknown> | undefined)?.[segment];
    if (typeof value !== 'string') return String(options.defaultValue ?? key);
    return value.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options[name] ?? ''));
  };
}

describe('daemon user notice web localization', () => {
  it.each(LOCALES)('renders every known code through the %s locale catalog', (locale) => {
    const resource = JSON.parse(readFileSync(
      resolve(WEB_ROOT, `src/i18n/locales/${locale}.json`),
      'utf8',
    )) as Record<string, unknown>;
    const t = resourceTranslator(resource);
    for (const code of Object.values(DAEMON_USER_NOTICE_CODE)) {
      const rawParams = {
        limit: 2,
        bucket: 'test',
        minutes: 12,
        detail: 'bounded diagnostic detail',
        model: 'model-test',
        level: 'high',
        supported: 'low, medium, high',
      };
      const params = normalizeDaemonUserNoticeParams(code, rawParams);
      const localized = localizeDaemonUserNoticeEvent(noticeEvent(code, rawParams), t);
      let expected = t(DAEMON_USER_NOTICE_I18N_KEYS[code], params);
      if (typeof params.detail === 'string' && !expected.includes(params.detail)) {
        expected = `${expected} ${params.detail}`;
      }
      expect(localized.payload.text, `${locale}:${code}`).toBe(expected);
      expect(localized.payload.text, `${locale}:${code}`).not.toBe('English fallback');
    }
  });

  it.each(LOCALES)('keeps every dynamic supervision diagnostic visible in %s', (locale) => {
    const resource = JSON.parse(readFileSync(
      resolve(WEB_ROOT, `src/i18n/locales/${locale}.json`),
      'utf8',
    )) as Record<string, unknown>;
    const t = resourceTranslator(resource);
    const detail = 'backend codex-sdk/model-test unavailable: rate_limited; auditor deck_sub_x refused';
    const codes = [
      DAEMON_USER_NOTICE_CODE.SUPERVISION_RETURNED_CONTROL,
      DAEMON_USER_NOTICE_CODE.SUPERVISION_AUDIT_UNUSABLE,
      DAEMON_USER_NOTICE_CODE.SUPERVISION_AUDIT_ROUTE_REFUSED,
      DAEMON_USER_NOTICE_CODE.SUPERVISION_AUTHORITY_REHYDRATED,
    ];
    for (const code of codes) {
      const rendered = localizeDaemonUserNoticeEvent(noticeEvent(code, { detail }), t);
      expect(String(rendered.payload.text), `${locale}:${code}`).toContain(detail);
      expect(rendered.payload.text, `${locale}:${code}`).not.toBe('English fallback');
    }
  });

  it('falls back for legacy/unknown codes and rejects provider spoofing', () => {
    const t = () => 'localized';
    const unknown = noticeEvent('future_code');
    expect(localizeDaemonUserNoticeEvent(unknown, t)).toBe(unknown);
    const spoofed = { ...noticeEvent(DAEMON_USER_NOTICE_CODE.SUPERVISION_HUMAN_INPUT_BLOCKER), source: 'provider' } as TimelineEvent;
    expect(localizeDaemonUserNoticeEvent(spoofed, t)).toBe(spoofed);
  });
});
