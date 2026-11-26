/**
 * @vitest-environment jsdom
 *
 * tsk_f2a967730b: what a browser terminal looks like after it repaints from a
 * snapshot and then receives the raw PTY bytes that follow. Real xterm.js (no
 * mock), so the assertions are about the screen a user would see.
 */
import { describe, expect, it } from 'vitest';
import { Terminal } from 'xterm';
import { buildFullFrameWrite } from '../src/terminal-frame.js';

const write = (term: Terminal, data: string) => new Promise<void>((resolve) => term.write(data, resolve));
const rows = (term: Terminal) => Array.from({ length: term.rows }, (_, i) => term.buffer.active.getLine(i)?.translateToString(true) ?? '');
const fresh = (cols = 30, rowCount = 6) => new Terminal({ cols, rows: rowCount, convertEol: true, allowProposedApi: true });

describe('buildFullFrameWrite', () => {
  it('puts the cursor where the application left it, so cursor-relative bytes land on the right row', async () => {
    const term = fresh();
    // tmux screen: two output lines, a prompt on row 3, cursor right after "$ ".
    await write(term, buildFullFrameWrite({
      lines: ['hello', 'world', '$ ', '', '', ''],
      cursor: { x: 2, y: 2, visible: true },
    }));
    expect([term.buffer.active.cursorX, term.buffer.active.cursorY]).toEqual([2, 2]);
    // An echoed keystroke, then a carriage-return counter redraw on the same row.
    await write(term, 'ls');
    expect(rows(term)[2]).toBe('$ ls');
    await write(term, '\rcount 42');
    expect(rows(term)[2]).toBe('count 42');
    expect(rows(term)[5]).toBe('');
  });

  it('without a cursor it keeps the old behaviour (older daemon): no cursor sequence is added', () => {
    const frame = buildFullFrameWrite({ lines: ['a', 'b'] });
    expect(frame).toContain('\x1b[H');
    expect(frame).not.toContain('\x1b[?25');
    expect(frame.endsWith('\x1b[J')).toBe(true);
  });

  it('honours a hidden cursor', () => {
    expect(buildFullFrameWrite({ lines: ['x'], cursor: { x: 0, y: 0, visible: false } })).toContain('\x1b[?25l');
    expect(buildFullFrameWrite({ lines: ['x'], cursor: { x: 0, y: 0, visible: true } })).toContain('\x1b[?25h');
  });

  it('repaints the alternate screen AND the normal screen behind it, so leaving the application restores the shell', async () => {
    const term = fresh();
    // Resync in the middle of a full-screen application.
    await write(term, buildFullFrameWrite({
      lines: ['ALT-PAGE-1', '', '', '', '', ''],
      cursor: { x: 0, y: 5, visible: true },
      altScreen: true,
      normalLines: ['NORMAL-1', 'NORMAL-2', '$ vim file', '', '', ''],
    }));
    expect(rows(term)[0]).toBe('ALT-PAGE-1');
    // The application redraws page 2 with cursor addressing, then exits.
    await write(term, '\x1b[1;1H\x1b[KALT-PAGE-2');
    expect(rows(term)[0]).toBe('ALT-PAGE-2');
    await write(term, '\x1b[?1049l');
    expect(rows(term).slice(0, 3)).toEqual(['NORMAL-1', 'NORMAL-2', '$ vim file']);
    expect(rows(term).join('\n')).not.toContain('ALT-PAGE');
    // The shell prompt is written below the command, where the real cursor was.
    await write(term, '$ ');
    expect(rows(term)[3]).toBe('$ ');
  });

  it('a normal-screen snapshot taken while the terminal still believes it is on the alternate screen leaves it', async () => {
    const term = fresh();
    await write(term, '\x1b[?1049h\x1b[HSTALE-ALT-CONTENT');
    expect(rows(term)[0]).toBe('STALE-ALT-CONTENT');
    await write(term, buildFullFrameWrite({ lines: ['$ ', '', '', '', '', ''], cursor: { x: 2, y: 0, visible: true } }));
    expect(rows(term)[0]).toBe('$ ');
    await write(term, '\x1b[?1049l');
    expect(rows(term)[0]).toBe('$ ');
  });
});
