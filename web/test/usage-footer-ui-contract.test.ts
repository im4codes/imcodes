import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = resolve(__dirname, '..');

describe('UsageFooter quota and history-refresh integration contract', () => {
  it('wires the existing timeline refresh into every full and pinned session footer', () => {
    const main = readFileSync(resolve(WEB_ROOT, 'src/components/SessionPane.tsx'), 'utf8');
    const standalone = readFileSync(resolve(WEB_ROOT, 'src/components/SubSessionWindow.tsx'), 'utf8');
    const pinned = readFileSync(resolve(WEB_ROOT, 'src/components/pinnedPanelTypes.tsx'), 'utf8');

    expect(main).toContain('onRefreshHistory={timelineForceRefresh}');
    expect(main).toContain('historyRefreshing={timelineRefreshing}');
    expect(main).toContain('historyStatus={timelineHistoryStatus}');
    expect(standalone).toContain('onRefreshHistory={timelineForceRefresh}');
    expect(standalone).toContain('historyRefreshing={refreshing}');
    expect(standalone).toContain('historyStatus={timelineHistoryStatus}');
    expect(pinned).toContain('onRefreshHistory={forceRefresh}');
    expect(pinned).toContain('historyRefreshing={refreshing}');
    expect(pinned).toContain('historyStatus={historyStatus}');
  });

  it('keeps one compact quota element readable instead of truncating narrow layouts', () => {
    const component = readFileSync(resolve(WEB_ROOT, 'src/components/UsageFooter.tsx'), 'utf8');
    const sharedLine = readFileSync(resolve(WEB_ROOT, 'src/components/ProviderQuotaLine.tsx'), 'utf8');
    const css = readFileSync(resolve(WEB_ROOT, 'src/styles.css'), 'utf8');
    expect(component).not.toContain(".split(' · ')");
    expect(component.match(/<ProviderQuotaLine text=\{providerQuotaText\}/g)).toHaveLength(1);
    expect(sharedLine.match(/session-usage-codex-line-compact/g)).toHaveLength(1);

    const compactRule = css.match(/\.session-usage-codex-line-compact\s*\{[^}]*\}/)?.[0];
    expect(compactRule).toMatch(/max-width:\s*100%/);
    expect(compactRule).toMatch(/white-space:\s*normal/);
    expect(compactRule).not.toMatch(/text-overflow:\s*ellipsis|overflow:\s*hidden/);
  });

  it('has localized refresh labels in all seven locales', () => {
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'es', 'ru', 'ja', 'ko']) {
      const messages = JSON.parse(readFileSync(resolve(WEB_ROOT, `src/i18n/locales/${locale}.json`), 'utf8'));
      expect(messages.chat.sync_history).toEqual(expect.any(String));
      expect(messages.chat.refreshing_history).toEqual(expect.any(String));
    }
  });
});
