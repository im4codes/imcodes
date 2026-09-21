import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = resolve(__dirname, '..');

describe('participant audit/quota/heartbeat status wiring', () => {
  it('feeds the same authoritative metadata into every main, sub-session and pinned chat entry point', () => {
    for (const host of ['SessionPane.tsx', 'SubSessionCard.tsx', 'SubSessionWindow.tsx', 'pinnedPanelTypes.tsx']) {
      const source = readFileSync(resolve(WEB_ROOT, `src/components/${host}`), 'utf8');
      expect(source, host).toContain('quotaLabel=');
      expect(source, host).toContain('quotaMeta=');
      expect(source, host).toContain('supervisionMode=');
      expect(source, host).toContain('supervisionHeartbeat=');
    }
  });

  it('keeps the compact strip above history on full views and scrollable rather than clipped on narrow views', () => {
    const css = readFileSync(resolve(WEB_ROOT, 'src/styles.css'), 'utf8');
    const strip = css.match(/\.chat-participant-status\s*\{[^}]*\}/s)?.[0];
    expect(strip).toMatch(/position:\s*sticky/);
    expect(strip).toMatch(/overflow-x:\s*auto/);
    expect(strip).toMatch(/max-width:\s*100%/);
    expect(css).toMatch(/\.chat-participant-quota\s*\{[^}]*white-space:\s*nowrap/s);
    expect(css).toMatch(/\.chat-view-preview \.chat-participant-status\s*\{[^}]*position:\s*relative/s);
    expect(css).toMatch(/\.chat-participant-status \+ \.agent-todos\s*\{[^}]*top:\s*29px/s);
  });

  it('uses existing localized audit, quota and heartbeat labels in all seven locales', () => {
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'es', 'ru', 'ja', 'ko']) {
      const json = JSON.parse(readFileSync(resolve(WEB_ROOT, `src/i18n/locales/${locale}.json`), 'utf8'));
      expect(json.peerAuditQuick.result_pass).toEqual(expect.any(String));
      expect(json.peerAuditQuick.result_rework).toEqual(expect.any(String));
      expect(json.peerAuditResult.roundAria).toContain('{{round}}');
      expect(json.session.provider_quota_title).toContain('{{value}}');
      expect(json.session.supervision.heartbeat.idle).toEqual(expect.any(String));
    }
  });
});
