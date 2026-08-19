/**
 * @vitest-environment jsdom
 *
 * Clicking anywhere in a background window must raise it. The bubbling
 * `onMouseDown` alone was not enough: an inner widget that calls
 * stopPropagation (xterm with mouse reporting enabled, a canvas, an embed)
 * silently swallowed the raise, which is why activating a covered window
 * worked sometimes and not others depending on where you clicked.
 */
import { describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { render, fireEvent, cleanup } from '@testing-library/preact';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../../src/components/TerminalView.js', () => ({ TerminalView: () => null }));
vi.mock('../../src/components/FileBrowser.js', () => ({ FileBrowser: () => null }));
vi.mock('../../src/components/ChatView.js', () => ({
  // Stands in for any inner widget that swallows the event on its way up.
  ChatView: () => (
    <div
      data-testid="swallowing-widget"
      onPointerDown={(e: any) => e.stopPropagation()}
      onMouseDown={(e: any) => e.stopPropagation()}
      style={{ height: 200 }}
    />
  ),
}));
vi.mock('../../src/components/SessionControls.js', () => ({ SessionControls: () => null }));
vi.mock('../../src/components/UsageFooter.js', () => ({ UsageFooter: () => null }));

const { SubSessionWindow } = await import('../../src/components/SubSessionWindow.js');

const ws = {
  onMessage: () => () => undefined,
  subscribeTerminal() {}, unsubscribeTerminal() {},
  sendSnapshotRequest() {}, sendResize() {},
  fsGitStatus() { return 'req-1'; }, send() {},
} as any;

describe('SubSessionWindow raise-on-click', () => {
  it('raises the window even when an inner widget stops propagation', () => {
    const onFocus = vi.fn();
    const sub: any = {
      id: 'sub-1', sessionName: 'deck_sub_1', label: 'L',
      type: 'codex-sdk', cwd: '/x', parentSession: 'deck_p_brain', state: 'idle',
    };
    const { container } = render(
      <SubSessionWindow
        sub={sub} ws={ws} connected active={false}
        onDiff={vi.fn()} onHistory={vi.fn()} onMinimize={vi.fn()} onClose={vi.fn()}
        onRestart={vi.fn()} onRename={vi.fn()} zIndex={1} onFocus={onFocus}
      />,
    );
    const widget = container.querySelector('[data-testid="swallowing-widget"]');
    expect(widget).toBeTruthy();

    fireEvent.pointerDown(widget!);
    expect(onFocus).toHaveBeenCalled();
    cleanup();
  });
});
