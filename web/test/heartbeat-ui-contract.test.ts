import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = resolve(__dirname, '..');

describe('heartbeat UI wiring and accessibility contract', () => {
  it('mounts the single heartbeat badge on the supervision dropdown for every session form', () => {
    const source = readFileSync(resolve(WEB_ROOT, 'src/components/SessionControls.tsx'), 'utf8');
    expect(source.match(/<SupervisionHeartbeatBadge/g)).toHaveLength(1);
    expect(source).toContain('heartbeat={activeSession?.supervisionHeartbeat}');
    expect(source).toContain('mode={quickSupervisionMode}');
    for (const host of ['SubSessionCard.tsx', 'SubSessionWindow.tsx']) {
      expect(readFileSync(resolve(WEB_ROOT, `src/components/${host}`), 'utf8'))
        .toContain('supervisionHeartbeat: sub.supervisionHeartbeat');
    }
  });

  it('uses fixed chip geometry and disables every new animation for reduced motion', () => {
    const css = readFileSync(resolve(WEB_ROOT, 'src/styles.css'), 'utf8');
    expect(css).toMatch(/\.supervision-heartbeat-badge\s*\{[^}]*position:\s*absolute[^}]*font-variant-numeric:\s*tabular-nums/s);
    expect(css).toContain('@keyframes supervision-heartbeat-pulse');
    expect(css).toContain('@keyframes chat-heartbeat-beat');
    expect(css).toContain('@keyframes chat-waiting-sway');
    const heartbeatReducedSelector = '.supervision-heartbeat-badge.is-sending,\n  .shortcut-btn-history-refresh.is-refreshing .shortcut-btn-history-refresh-glyph,\n  .chat-execution-status-chip.waiting';
    const selectorAt = css.indexOf(heartbeatReducedSelector);
    const reducedAt = css.lastIndexOf('@media (prefers-reduced-motion: reduce)', selectorAt);
    const reduced = css.slice(reducedAt, css.indexOf('\n}', selectorAt) + 2);
    expect(reduced).toContain('.supervision-heartbeat-badge.is-sending');
    expect(reduced).toContain('.chat-execution-status-chip.waiting .chat-execution-status-glyph');
    expect(reduced).toContain('.chat-supervision-heartbeat-glyph');
    expect(reduced).toMatch(/animation:\s*none/);
  });

  it('keeps the toolbar heartbeat superscript above siblings without clipping it', () => {
    const css = readFileSync(resolve(WEB_ROOT, 'src/styles.css'), 'utf8');
    const rootRule = css.match(/:root\s*\{[^}]*\}/s)?.[0];
    expect(rootRule).toMatch(/--toolbar-raised-control-z:\s*2/);
    expect(rootRule).toMatch(/--toolbar-badge-z:\s*3/);

    const hostRule = css.match(/\.shortcuts-model-supervision\s*\{[^}]*\}/)?.[0];
    expect(hostRule).toMatch(/position:\s*relative/);
    expect(hostRule).toMatch(/z-index:\s*var\(--toolbar-raised-control-z\)/);
    expect(hostRule).toMatch(/overflow:\s*visible/);

    const badgeRule = css.match(/\.supervision-heartbeat-badge\s*\{[^}]*\}/)?.[0];
    expect(badgeRule).toMatch(/position:\s*absolute/);
    expect(badgeRule).toMatch(/z-index:\s*var\(--toolbar-badge-z\)/);
    // The mobile horizontal scroller clips outside its scrollport. The
    // supervision host already has 4px block padding, so keeping the offset
    // within that inset preserves the superscript without growing the row.
    expect(badgeRule).toMatch(/top:\s*-3px/);
  });

  it('gives the neutral idle glyph its own theme-safe presentation', () => {
    const component = readFileSync(resolve(WEB_ROOT, 'src/components/SupervisionHeartbeatBadge.tsx'), 'utf8');
    const css = readFileSync(resolve(WEB_ROOT, 'src/styles.css'), 'utf8');
    expect(component).toContain('supervision-heartbeat-glyph is-idle');
    expect(css).toMatch(/\.supervision-heartbeat-glyph\.is-idle\s*\{[^}]*color:\s*var\(--[^)]+\)/s);
  });

  it('keeps the heartbeat translation surface complete in every locale', () => {
    const locales = ['en', 'zh-CN', 'zh-TW', 'es', 'ru', 'ja', 'ko'];
    for (const locale of locales) {
      const json = JSON.parse(readFileSync(resolve(WEB_ROOT, `src/i18n/locales/${locale}.json`), 'utf8'));
      expect(json.session.supervision.heartbeat).toMatchObject({
        idle: expect.any(String),
        needsInput: expect.any(String),
        sending: expect.any(String),
        armedLabel: expect.stringContaining('{{countdown}}'),
        sendingLabel: expect.stringContaining('{{time}}'),
        kind: {
          waiting: expect.any(String),
          audit: expect.any(String),
          implementation: expect.any(String),
        },
      });
    }
  });
});
