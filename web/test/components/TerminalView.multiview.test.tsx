/**
 * @vitest-environment jsdom
 *
 * tsk_f2a967730b: one session shown by two terminal views at once (a sub-session
 * card's preview and its open window). Snapshots must reach BOTH; the view that
 * asked for a resync is not necessarily the one the last registration belongs to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { render } from '@testing-library/preact';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('xterm', () => ({ Terminal: vi.fn() }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn().mockImplementation(() => ({ fit: vi.fn() })) }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn().mockImplementation(() => ({})) }));
global.ResizeObserver = vi.fn().mockImplementation(() => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }));

import { Terminal } from 'xterm';
import { TerminalView } from '../../src/components/TerminalView.js';
import { TerminalDiffRegistry } from '../../src/terminal-diff-registry.js';

const SESSION = 'shared-shell';
const writesByTerminal: string[][] = [];

function installTerminalMock() {
  writesByTerminal.length = 0;
  (Terminal as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
    const writes: string[] = [];
    writesByTerminal.push(writes);
    return {
      open: vi.fn(),
      write: vi.fn((data: Uint8Array | string, done?: () => void) => {
        writes.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
        done?.();
      }),
      reset: vi.fn(), loadAddon: vi.fn(), dispose: vi.fn(), options: {}, attachCustomKeyEventHandler: vi.fn(),
      hasSelection: vi.fn().mockReturnValue(false), getSelection: vi.fn().mockReturnValue(''),
      onData: vi.fn(), onResize: vi.fn(), onScroll: vi.fn(), focus: vi.fn(), scrollToBottom: vi.fn(),
      buffer: { active: { baseY: 0, viewportY: 0 } }, cols: 80, rows: 24,
    };
  });
}

const ws = () => ({
  onTerminalRaw: vi.fn(() => vi.fn()),
  onMessage: vi.fn(() => vi.fn()),
  sendSnapshotRequest: vi.fn(),
  sendResize: vi.fn(),
  sendInput: vi.fn(),
});

const frame = (marker: string) => ({ sessionName: SESSION, rows: 1, lines: [[0, marker]] as Array<[number, string]>, fullFrame: true });

describe('two terminal views of one session', () => {
  beforeEach(() => { vi.clearAllMocks(); installTerminalMock(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a snapshot repaints both, regardless of which registered last', () => {
    const registry = new TerminalDiffRegistry();
    const preview = render(<TerminalView sessionName={SESSION} ws={ws() as never} preview onDiff={(apply) => registry.register(SESSION, apply)} />);
    const win = render(<TerminalView sessionName={SESSION} ws={ws() as never} onDiff={(apply) => registry.register(SESSION, apply)} />);
    expect(registry.size(SESSION)).toBe(2);
    registry.dispatch(SESSION, frame('snapshot'));
    expect(writesByTerminal).toHaveLength(2);
    for (const writes of writesByTerminal) expect(writes.join('')).toContain('snapshot');
    preview.unmount();
    win.unmount();
  });

  it('closing the window leaves the preview registered and still receiving', () => {
    const registry = new TerminalDiffRegistry();
    const preview = render(<TerminalView sessionName={SESSION} ws={ws() as never} preview onDiff={(apply) => registry.register(SESSION, apply)} />);
    const win = render(<TerminalView sessionName={SESSION} ws={ws() as never} onDiff={(apply) => registry.register(SESSION, apply)} />);
    win.unmount();
    expect(registry.size(SESSION)).toBe(1);
    registry.dispatch(SESSION, frame('after-window-closed'));
    expect(writesByTerminal[0]!.join('')).toContain('after-window-closed');
    preview.unmount();
    expect(registry.size(SESSION)).toBe(0);
  });

  it('a parent re-render that hands the view a new registration function does not stack registrations', () => {
    const registry = new TerminalDiffRegistry();
    const view = render(<TerminalView sessionName={SESSION} ws={ws() as never} onDiff={(apply) => registry.register(SESSION, apply)} />);
    for (let i = 0; i < 5; i += 1) {
      view.rerender(<TerminalView sessionName={SESSION} ws={ws() as never} onDiff={(apply) => registry.register(SESSION, apply)} />);
    }
    expect(registry.size(SESSION)).toBe(1);
    view.unmount();
    expect(registry.size(SESSION)).toBe(0);
  });
});
