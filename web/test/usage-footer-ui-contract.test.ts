import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = resolve(__dirname, '..');

describe('UsageFooter quota and ChatView top-bar integration contract', () => {
  it('wires manual timeline sync into ChatView top actions and keeps UsageFooter free of duplicate sync/usage buttons', () => {
    const main = readFileSync(resolve(WEB_ROOT, 'src/components/SessionPane.tsx'), 'utf8');
    const standalone = readFileSync(resolve(WEB_ROOT, 'src/components/SubSessionWindow.tsx'), 'utf8');
    const pinned = readFileSync(resolve(WEB_ROOT, 'src/components/pinnedPanelTypes.tsx'), 'utf8');
    const footer = readFileSync(resolve(WEB_ROOT, 'src/components/UsageFooter.tsx'), 'utf8');
    const chatView = readFileSync(resolve(WEB_ROOT, 'src/components/ChatView.tsx'), 'utf8');

    expect(main).toContain('onForceSync={timelineForceRefresh}');
    expect(main).not.toContain('onRefreshHistory=');
    expect(standalone).toContain('onForceSync={timelineForceRefresh}');
    expect(standalone).not.toContain('onRefreshHistory=');
    expect(pinned).toContain('onForceSync={forceRefresh}');
    expect(pinned).not.toContain('onRefreshHistory=');

    expect(footer).not.toContain('shortcut-btn-history-refresh');
    expect(footer).not.toContain('shortcut-btn-session-usage');
    expect(chatView).toContain('chat-sync-btn');
    expect(chatView).toContain('chat-session-usage-btn');
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
