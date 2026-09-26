import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DAEMON_USER_NOTICE_CODE,
  DAEMON_USER_NOTICE_I18N_KEYS,
  DAEMON_USER_NOTICE_PARAM_KEYS,
  attachDaemonUserNotice,
  createDaemonUserNoticePayload,
} from '../../shared/daemon-user-notices.js';

const LOCALES = ['en', 'zh-CN', 'zh-TW', 'es', 'ru', 'ja', 'ko'] as const;

describe('daemon user notice contract', () => {
  it('keeps every code translated in all seven locales', () => {
    const codes = Object.values(DAEMON_USER_NOTICE_CODE);
    expect(new Set(codes).size).toBe(codes.length);
    const english = JSON.parse(readFileSync(
      resolve(process.cwd(), 'web/src/i18n/locales/en.json'),
      'utf8',
    )) as { chat?: { daemon_notice?: Record<string, unknown> } };
    for (const locale of LOCALES) {
      const resource = JSON.parse(readFileSync(
        resolve(process.cwd(), `web/src/i18n/locales/${locale}.json`),
        'utf8',
      )) as { chat?: { daemon_notice?: Record<string, unknown> } };
      const notices = resource.chat?.daemon_notice ?? {};
      for (const code of codes) {
        const value = notices[code];
        expect(value, `${locale}:${code}`).toBeTypeOf('string');
        expect(String(value).trim(), `${locale}:${code}`).not.toBe('');
        expect(String(value), `${locale}:${code}`).not.toBe(DAEMON_USER_NOTICE_I18N_KEYS[code]);
        if (locale !== 'en') {
          expect(String(value), `${locale}:${code}`).not.toBe(String(english.chat?.daemon_notice?.[code]));
        }
      }
    }
  });

  it('emits the exact English fallback with a typed code and bounded allow-listed params', () => {
    const payload = createDaemonUserNoticePayload(
      DAEMON_USER_NOTICE_CODE.SUPERVISION_REPEAT_CONTINUE_LIMIT,
      { limit: 2, bucket: 'test_verify', secretPath: '/Users/private/token' },
    );
    expect(payload).toEqual({
      text: '⚠️ Automation reached the repeated auto-continue limit (2) for test_verify; handing control back to the human.',
      noticeCode: DAEMON_USER_NOTICE_CODE.SUPERVISION_REPEAT_CONTINUE_LIMIT,
      noticeParams: { limit: 2, bucket: 'test_verify' },
    });
  });

  it('preserves the English fallback and carries only a bounded, redacted diagnostic detail', () => {
    const payload = createDaemonUserNoticePayload(
      DAEMON_USER_NOTICE_CODE.SUPERVISION_AUDIT_ROUTE_REFUSED,
      { detail: `auditor route failed token=supersecret ${'x'.repeat(250)}`, hidden: 'token' },
      'Automation peer audit cannot use the configured auditor: unavailable. Manual review is required.',
    );
    expect(payload).toMatchObject({
      text: '⚠️ Automation peer audit cannot use the configured auditor: unavailable. Manual review is required.',
      noticeCode: DAEMON_USER_NOTICE_CODE.SUPERVISION_AUDIT_ROUTE_REFUSED,
    });
    expect(payload.noticeParams.detail).toContain('token=[redacted]');
    expect(String(payload.noticeParams.detail)).not.toContain('supersecret');
    expect(String(payload.noticeParams.detail).length).toBeLessThanOrEqual(200);
    expect(payload.noticeParams).not.toHaveProperty('hidden');
  });

  it('declares an explicit structured-param path for every dynamic notice class', () => {
    const dynamic: Array<[string, string[]]> = [
      [DAEMON_USER_NOTICE_CODE.EXECUTION_POOL_UNCONFIGURED, ['detail']],
      [DAEMON_USER_NOTICE_CODE.SUPERVISION_RETURNED_CONTROL, ['detail']],
      [DAEMON_USER_NOTICE_CODE.SUPERVISION_AUDIT_UNUSABLE, ['detail']],
      [DAEMON_USER_NOTICE_CODE.SUPERVISION_AUDIT_ROUTE_REFUSED, ['detail']],
      [DAEMON_USER_NOTICE_CODE.SUPERVISION_AUTHORITY_REHYDRATED, ['detail']],
      [DAEMON_USER_NOTICE_CODE.SUPERVISION_REPEAT_CONTINUE_LIMIT, ['limit', 'bucket']],
      [DAEMON_USER_NOTICE_CODE.SUPERVISION_CONTINUE_HARD_LIMIT, ['limit']],
      [DAEMON_USER_NOTICE_CODE.CODEX_WATCHDOG_RECOVERED, ['minutes']],
      [DAEMON_USER_NOTICE_CODE.MEMORY_WATCHDOG_RECOVERED, ['minutes']],
      [DAEMON_USER_NOTICE_CODE.TRANSPORT_RECOVERY_STOPPED, ['limit', 'minutes']],
      [DAEMON_USER_NOTICE_CODE.TRANSPORT_RECOVERING, ['count', 'detail']],
      [DAEMON_USER_NOTICE_CODE.TRANSPORT_AUTO_RESTART_FAILED, ['detail']],
      [DAEMON_USER_NOTICE_CODE.QUEUED_MESSAGES_EXPIRED, ['count', 'minutes']],
      [DAEMON_USER_NOTICE_CODE.QUEUED_MESSAGES_FAILED, ['count']],
      [DAEMON_USER_NOTICE_CODE.AUDIT_WORKER_PROVISION_REFUSED, ['detail']],
      [DAEMON_USER_NOTICE_CODE.SESSION_STOP_FAILED, ['detail']],
      [DAEMON_USER_NOTICE_CODE.ALIAS_UNRESOLVED, ['count', 'detail']],
      [DAEMON_USER_NOTICE_CODE.QUEUE_OVERFLOW, ['limit']],
      [DAEMON_USER_NOTICE_CODE.SESSION_AUTO_RESUME_FAILED, ['detail']],
      [DAEMON_USER_NOTICE_CODE.CONVERSATION_CLEAR_FAILED, ['detail']],
      [DAEMON_USER_NOTICE_CODE.SERVICE_TIER_CHANGE_FAILED, ['detail']],
      [DAEMON_USER_NOTICE_CODE.UNKNOWN_MODEL, ['model']],
      [DAEMON_USER_NOTICE_CODE.MODEL_SWITCHED, ['model']],
      [DAEMON_USER_NOTICE_CODE.MODEL_SWITCH_PROOF_GATED, ['model']],
      [DAEMON_USER_NOTICE_CODE.THINKING_LEVEL_UNSUPPORTED, ['level']],
      [DAEMON_USER_NOTICE_CODE.THINKING_LEVEL_SWITCHED, ['level']],
      [DAEMON_USER_NOTICE_CODE.MESSAGE_SEND_FAILED, ['detail']],
      [DAEMON_USER_NOTICE_CODE.COMPACT_FAILED, ['detail']],
      [DAEMON_USER_NOTICE_CODE.SESSION_INLINE_ERROR, ['detail']],
    ];
    for (const [code, expectedKeys] of dynamic) {
      expect(DAEMON_USER_NOTICE_PARAM_KEYS[code as keyof typeof DAEMON_USER_NOTICE_PARAM_KEYS], code)
        .toEqual(expect.arrayContaining(expectedKeys));
    }
  });

  it('attaches metadata without changing an existing information or warning rendering', () => {
    expect(attachDaemonUserNotice(
      DAEMON_USER_NOTICE_CODE.MODEL_SWITCHED,
      'Switched model to gpt-test',
      { model: 'gpt-test', secret: '/private/path' },
    )).toEqual({
      text: 'Switched model to gpt-test',
      noticeCode: DAEMON_USER_NOTICE_CODE.MODEL_SWITCHED,
      noticeParams: { model: 'gpt-test' },
    });
  });

  it('guards supervision warnings against new bare display strings', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/daemon/supervision-automation.ts'), 'utf8');
    const calls = source.match(/this\.emitWarning\(/g) ?? [];
    expect(calls.length).toBeGreaterThan(20);
    expect(source).not.toMatch(/this\.emitWarning\(\s*[^,]+,\s*['"`]/m);
  });

  it('guards migrated daemon-authored notice surfaces against bare display prose', () => {
    const files = [
      'src/daemon/lifecycle.ts',
      'src/agent/session-manager.ts',
      'src/daemon/session-dispatch.ts',
      'src/daemon/send-tool.ts',
      'src/daemon/command-handler.ts',
      'src/daemon/session-error.ts',
    ];
    const bareNotice = /text:\s*(?:`|'|")(?:(?:⚠️|⏳)|Started a fresh conversation|Switched (?:model|thinking level)|Fast mode)/;
    for (const file of files) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      expect(source, file).not.toMatch(bareNotice);
    }
  });
});
