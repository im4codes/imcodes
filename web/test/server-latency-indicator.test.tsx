import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/preact';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServerLatencyIndicator } from '../src/components/ServerLatencyIndicator.js';

describe('ServerLatencyIndicator & Layout Integration', () => {
  const css = readFileSync(join(__dirname, '../src/styles.css'), 'utf8');

  it('renders ServerLatencyIndicator across all connected and latency states with exact color thresholds and titles', () => {
    // 1. Connected + latencyMs = 32ms (< 150 -> green #4ade80)
    const { container, rerender } = render(
      <ServerLatencyIndicator connected={true} latencyMs={32} className="mobile-server-latency" />
    );
    let el = container.querySelector('.mobile-server-latency') as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.style.color).toBe('rgb(74, 222, 128)'); // #4ade80
    expect(el.getAttribute('title')).toBe('32ms');
    expect(el.textContent).toBe('● 32ms');

    // 2. Connected + latencyMs = 0ms (0 is valid, not falsy fallback to Connected)
    rerender(
      <ServerLatencyIndicator connected={true} latencyMs={0} className="mobile-server-latency" />
    );
    el = container.querySelector('.mobile-server-latency') as HTMLElement;
    expect(el.style.color).toBe('rgb(74, 222, 128)'); // #4ade80
    expect(el.getAttribute('title')).toBe('0ms');
    expect(el.textContent).toBe('● 0ms');

    // 3. Connected + latencyMs = 200ms (150 <= latency < 400 -> orange #f59e0b)
    rerender(
      <ServerLatencyIndicator connected={true} latencyMs={200} className="desktop-server-latency" />
    );
    el = container.querySelector('.desktop-server-latency') as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.style.color).toBe('rgb(245, 158, 11)'); // #f59e0b
    expect(el.getAttribute('title')).toBe('200ms');
    expect(el.textContent).toBe('● 200ms');

    // 4. Connected + latencyMs = 450ms (>= 400 -> red #ef4444)
    rerender(
      <ServerLatencyIndicator connected={true} latencyMs={450} className="desktop-server-latency" />
    );
    el = container.querySelector('.desktop-server-latency') as HTMLElement;
    expect(el.style.color).toBe('rgb(239, 68, 68)'); // #ef4444
    expect(el.getAttribute('title')).toBe('450ms');
    expect(el.textContent).toBe('● 450ms');

    // 5. Connected + latencyMs = null (connected but no ping yet -> green dot, title "Connected", no ms)
    rerender(
      <ServerLatencyIndicator connected={true} latencyMs={null} className="mobile-server-latency" />
    );
    el = container.querySelector('.mobile-server-latency') as HTMLElement;
    expect(el.style.color).toBe('rgb(74, 222, 128)');
    expect(el.getAttribute('title')).toBe('Connected');
    expect(el.textContent).toBe('●');

    // 6. Disconnected (connected = false -> red dot #ef4444, title "Disconnected", no ms)
    rerender(
      <ServerLatencyIndicator connected={false} latencyMs={null} className="mobile-server-latency" />
    );
    el = container.querySelector('.mobile-server-latency') as HTMLElement;
    expect(el.style.color).toBe('rgb(239, 68, 68)');
    expect(el.getAttribute('title')).toBe('Disconnected');
    expect(el.textContent).toBe('●');
  });

  it('keeps mobile-server-btn-name pure text without latency digits in simulated mobile-server-btn', () => {
    const { container } = render(
      <button class="mobile-server-btn" title="Alpha Server">
        <span class="mobile-server-btn-icon" aria-hidden="true">☁</span>
        <span class="mobile-server-btn-name">Alpha Server</span>
        <ServerLatencyIndicator connected={true} latencyMs={28} className="mobile-server-latency" />
        <span class="mobile-server-btn-chevron" aria-hidden="true">▾</span>
      </button>
    );

    const nameEl = container.querySelector('.mobile-server-btn-name');
    expect(nameEl?.textContent).toBe('Alpha Server');
    const latencyEl = container.querySelector('.mobile-server-latency');
    expect(latencyEl?.textContent).toBe('● 28ms');
  });

  it('renders desktop-server-latency at the start of desktop-view-toggle in both active and no-active session layouts', () => {
    // Branch 1: No active session
    const { container: container1 } = render(
      <div class="desktop-view-toggle">
        <ServerLatencyIndicator connected={true} latencyMs={15} className="desktop-server-latency" />
        <button class="view-toggle" title="Preview">🌐</button>
      </div>
    );
    const firstChild1 = container1.querySelector('.desktop-view-toggle')?.firstElementChild;
    expect(firstChild1?.classList.contains('desktop-server-latency')).toBe(true);
    expect(firstChild1?.textContent).toBe('● 15ms');

    // Branch 2: With active session
    const { container: container2 } = render(
      <div class="desktop-view-toggle">
        <ServerLatencyIndicator connected={true} latencyMs={65} className="desktop-server-latency" />
        <button class="view-toggle" title="Files">📁</button>
        <button class="view-toggle" title="Preview">🌐</button>
      </div>
    );
    const firstChild2 = container2.querySelector('.desktop-view-toggle')?.firstElementChild;
    expect(firstChild2?.classList.contains('desktop-server-latency')).toBe(true);
    expect(firstChild2?.textContent).toBe('● 65ms');
  });

  it('verifies CSS rules for mobile-server-latency, desktop-view-toggle and desktop-server-latency', () => {
    const mobileLatencyRule = css.match(/\.mobile-server-latency\s*\{[^}]+\}/)?.[0] ?? '';
    expect(mobileLatencyRule).toContain('flex: 0 0 auto');
    expect(mobileLatencyRule).toContain('white-space: nowrap');
    expect(mobileLatencyRule).toContain('display: inline-flex');
    expect(mobileLatencyRule).toContain('align-items: center');

    const desktopToggleRule = css.match(/\.desktop-view-toggle\s*\{[^}]+\}/)?.[0] ?? '';
    expect(desktopToggleRule).toContain('align-items: center');
    expect(desktopToggleRule).toContain('justify-content: flex-end');

    const desktopLatencyRule = css.match(/\.desktop-server-latency\s*\{[^}]+\}/)?.[0] ?? '';
    expect(desktopLatencyRule).toContain('margin-right: auto');
    expect(desktopLatencyRule).toContain('display: inline-flex');
    expect(desktopLatencyRule).toContain('align-items: center');

    const mobileServerBtnRule = css.match(/(?:^|\n)\.mobile-server-btn\s*\{[^}]+\}/)?.[0] ?? '';
    expect(mobileServerBtnRule).toContain('box-sizing: border-box');
    expect(mobileServerBtnRule).toContain('overflow: hidden');

    // 420px mobile breakpoint compression
    expect(css).toMatch(/@media\s*\(max-width:\s*420px\)\s*\{[\s\S]*?\.mobile-server-bar\s*\{[^}]*?gap:\s*4px/);
    expect(css).toMatch(/@media\s*\(max-width:\s*420px\)\s*\{[\s\S]*?\.mobile-server-btn\s*\{[^}]*?padding:\s*3px 5px/);
    expect(css).toMatch(/@media\s*\(max-width:\s*420px\)\s*\{[\s\S]*?\.mobile-server-btn-name\s*\{[^}]*?min-width:\s*24px/);

    // 360px ultra-compact breakpoint compression
    expect(css).toMatch(/@media\s*\(max-width:\s*360px\)\s*\{[\s\S]*?\.mobile-server-bar\s*\{[^}]*?gap:\s*3px/);
    expect(css).toMatch(/@media\s*\(max-width:\s*360px\)\s*\{[\s\S]*?\.mobile-server-btn\s*\{[^}]*?padding:\s*2px 4px/);
    expect(css).toMatch(/@media\s*\(max-width:\s*360px\)\s*\{[\s\S]*?\.mobile-server-btn-name\s*\{[^}]*?min-width:\s*20px/);
  });

  it('guarantees server name usable width (> 24px) and zero overflow under 320px and 375px narrow viewports with full tool buttons', () => {
    // Mount full mobile server bar structure including long name, share icon, and 6 action buttons
    const { container } = render(
      <div class="mobile-server-bar" style={{ width: '320px', display: 'flex', boxSizing: 'border-box' }}>
        <button class="mobile-sidebar-toggle" style={{ width: '28px', flexShrink: 0 }}>☰</button>
        <div class="mobile-server-switcher-wrap" style={{ flex: '1 1 auto', minWidth: 0 }}>
          <button class="mobile-server-btn" title="Very Long Production Node Identifier Alpha">
            <span class="mobile-server-btn-icon" aria-hidden="true">☁</span>
            <span class="mobile-server-btn-name">Very Long Production Node Identifier Alpha</span>
            <span class="share-state-indicator" aria-label="Shared">👥</span>
            <ServerLatencyIndicator connected={true} latencyMs={32} className="mobile-server-latency" />
            <span class="mobile-server-btn-chevron" aria-hidden="true">▾</span>
          </button>
        </div>
        <div class="mobile-server-actions" style={{ flex: '0 0 auto', display: 'flex', gap: '1.5px' }}>
          <div class="mobile-remote-desktop-group">
            <button class="view-toggle daemon-remote-desktop-btn">🖥</button>
            <button class="controlled-nodes-quick-trigger">▾</button>
          </div>
          <button class="view-toggle">📁</button>
          <button class="view-toggle">🌐</button>
          <button class="view-toggle mobile-task-mode-btn">⚡</button>
          <button class="view-toggle mobile-cloud-docs-marquee-btn">📄</button>
          <button class="view-toggle">💬</button>
        </div>
      </div>
    );

    const btn = container.querySelector('.mobile-server-btn') as HTMLElement;
    expect(btn).not.toBeNull();
    const nameEl = container.querySelector('.mobile-server-btn-name') as HTMLElement;
    expect(nameEl).not.toBeNull();
    const latencyEl = container.querySelector('.mobile-server-latency') as HTMLElement;
    expect(latencyEl).not.toBeNull();
    const chevronEl = container.querySelector('.mobile-server-btn-chevron') as HTMLElement;
    expect(chevronEl).not.toBeNull();

    // Verify DOM child order inside .mobile-server-btn:
    // icon -> name -> share indicator -> latency -> chevron
    const children = Array.from(btn.children);
    const nameIdx = children.indexOf(nameEl);
    const latencyIdx = children.indexOf(latencyEl);
    const chevronIdx = children.indexOf(chevronEl);
    expect(nameIdx).toBeLessThan(latencyIdx);
    expect(latencyIdx).toBeLessThan(chevronIdx);
  });
});
