/**
 * @vitest-environment jsdom
 *
 * tsk_f2a967730b - end to end, real tmux + the real TerminalStreamer + real
 * xterm.js: after a browser terminal loses bytes and resyncs from a snapshot,
 * is its screen - and its CURSOR - the pane's?
 *
 * The browser model drops every raw byte for a while (what the real view does
 * after an overflow / server drop), asks for a snapshot, then resumes. Whatever
 * the application does next (echo a key, redraw a counter, leave the alternate
 * screen) must land exactly as it does in tmux.
 *
 * Lives in web/ because xterm.js is a web dependency. Needs tmux; skipped when
 * tmux is missing, with SKIP_TMUX_TESTS=1, or inside a Claude Code session
 * (CLAUDECODE), like the other tmux tests. The session store is mocked: this
 * test must never touch a real ~/.imcodes.
 */
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/store/session-store.js', () => ({
  getSession: vi.fn(() => undefined),
  upsertSession: vi.fn(),
}));

import { Terminal } from 'xterm';
import { TerminalStreamer, type TerminalDiff } from '../../src/daemon/terminal-streamer.js';
import { applyDiffToRows, fullFrameWriteFromDiff } from '../src/terminal-frame.js';

function hasTmux(): boolean {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const SKIP = process.env.SKIP_TMUX_TESTS === '1' || !!process.env.CLAUDECODE || !hasTmux();
const COLS = 60;
const ROWS = 10;
const RUN_ID = Math.random().toString(36).slice(2, 8);
let sequence = 0;

const tmux = (...args: string[]) => execFileSync('tmux', args, { encoding: 'utf8' });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 8_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(40);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** A browser terminal: xterm fed exactly the way TerminalView feeds it. */
class BrowserModel {
  readonly term = new Terminal({ cols: COLS, rows: ROWS, convertEol: true, allowProposedApi: true });
  private lines: string[] = [];
  private chain: Promise<void> = Promise.resolve();
  /** While true every raw byte is discarded, as the real view does until a full frame. */
  dropping = false;
  fullFrames = 0;

  private write(data: string | Uint8Array): void {
    this.chain = this.chain.then(() => new Promise<void>((resolve) => this.term.write(data, resolve)));
  }
  raw(data: Buffer): void { if (!this.dropping) this.write(new Uint8Array(data)); }
  diff(diff: TerminalDiff): void {
    if (!diff.fullFrame) return;
    this.lines = applyDiffToRows(this.lines, diff);
    this.write(fullFrameWriteFromDiff(diff, this.lines));
    this.fullFrames += 1;
    this.dropping = false;
  }
  async settled(): Promise<void> { await this.chain; }
  screen(): string[] {
    // The visible screen is the LAST `ROWS` rows of the buffer: scrollback sits above it.
    const top = this.term.buffer.active.baseY;
    return Array.from({ length: ROWS }, (_, i) => (this.term.buffer.active.getLine(top + i)?.translateToString(true) ?? '').trimEnd());
  }
  cursor(): [number, number] { return [this.term.buffer.active.cursorX, this.term.buffer.active.cursorY]; }
}

function paneScreen(session: string): string[] {
  const rows = tmux('capture-pane', '-p', '-t', session).split('\n').slice(0, ROWS).map((line) => line.trimEnd());
  while (rows.length < ROWS) rows.push('');
  return rows;
}
function paneCursor(session: string): [number, number] {
  const [x, y] = tmux('display-message', '-p', '-t', session, '#{cursor_x},#{cursor_y}').trim().split(',').map(Number);
  return [x!, y!];
}

describe.skipIf(SKIP)('terminal resync fidelity (real tmux, real streamer, real xterm)', { timeout: 40_000, retry: 2 }, () => {
  let session: string;
  let streamer: TerminalStreamer;
  let model: BrowserModel;
  let unsubscribe: () => void;

  const start = async (command: string) => {
    tmux('new-session', '-d', '-s', session, '-x', String(COLS), '-y', String(ROWS), command);
    await sleep(250);
    streamer = new TerminalStreamer();
    model = new BrowserModel();
    unsubscribe = streamer.subscribe({
      sessionName: session,
      send: (diff) => model.diff(diff),
      sendRaw: (data) => model.raw(data),
    });
    await until(() => model.fullFrames >= 1, 8_000, 'the first-paint snapshot');
  };
  const typeLiteral = (text: string) => tmux('send-keys', '-t', session, '-l', text);
  /** The browser drops bytes, asks for a snapshot, and resumes once it arrives. */
  const loseBytesAndResync = async (whileDropping?: () => Promise<void>) => {
    model.dropping = true;
    if (whileDropping) await whileDropping();
    const before = model.fullFrames;
    streamer.requestSnapshot(session);
    await until(() => model.fullFrames > before, 8_000, 'the resync snapshot');
  };
  const expectSameAsPane = async () => {
    await sleep(500);
    await model.settled();
    expect(model.screen()).toEqual(paneScreen(session));
    expect(model.cursor()).toEqual(paneCursor(session));
  };

  beforeEach(() => { session = `deck_e2eresync${RUN_ID}${++sequence}_w1`; });
  afterEach(async () => {
    try { unsubscribe?.(); } catch { /* ignore */ }
    await streamer?.destroyAsync().catch(() => {});
    try { tmux('kill-session', '-t', session); } catch { /* already gone */ }
  });

  it('a keystroke echoed after a resync lands at the prompt, not on the bottom row', async () => {
    await start(`bash --norc --noprofile -c 'PS1="$ " bash --norc --noprofile -i'`);
    typeLiteral('echo hello');
    tmux('send-keys', '-t', session, 'Enter');
    await sleep(300);
    await loseBytesAndResync();
    typeLiteral('echo typed-after-resync');
    await sleep(300);
    await expectSameAsPane();
    expect(model.screen().join('\n')).toContain('$ echo typed-after-resync');
  });

  it('a carriage-return counter keeps updating on its own row after a resync', async () => {
    await start(`bash --norc --noprofile -c 'echo header; for i in $(seq 1 60); do printf "\\rcount %d   " $i; sleep 0.05; done; echo; sleep 30'`);
    await sleep(600);
    await loseBytesAndResync();
    await until(async () => paneScreen(session).join('\n').includes('count 60'), 8_000, 'the counter to finish');
    await expectSameAsPane();
    expect(model.screen().join('\n')).toContain('count 60');
  });

  it('leaving a full-screen application after a resync restores the shell screen', async () => {
    const app = [
      'echo NORMAL-LINE-1; echo NORMAL-LINE-2',
      "printf '\\033[?1049h\\033[H\\033[2JALT-PAGE-1'",
      'sleep 1.5',
      "printf '\\033[H\\033[2JALT-PAGE-2'",
      'sleep 1.5',
      "printf '\\033[?1049l'",
      'echo AFTER-EXIT',
      'sleep 30',
    ].join('; ');
    await start(`bash --norc --noprofile -c "${app}"`);
    await until(() => model.screen().join('\n').includes('ALT-PAGE-1'), 8_000, 'the application to draw page 1');
    // Resync while the application owns the alternate screen.
    await loseBytesAndResync();
    expect(model.screen().join('\n')).toContain('ALT-PAGE-1');
    await until(() => paneScreen(session).join('\n').includes('AFTER-EXIT'), 10_000, 'the application to exit');
    await expectSameAsPane();
    expect(model.screen().join('\n')).toContain('NORMAL-LINE-1');
    expect(model.screen().join('\n')).not.toContain('ALT-PAGE');
  });

  it('blank rows at the top of the screen keep their position in a snapshot', async () => {
    await start(`bash --norc --noprofile -c "printf '\\n\\n\\nFOO\\n'; sleep 60"`);
    await expectSameAsPane();
    expect(model.screen()[3]).toBe('FOO');
  });

  it('the last output of a burst is on screen after the burst ends even though the browser dropped it', async () => {
    await start(`bash --norc --noprofile -c 'sleep 1; for i in $(seq 1 300); do printf "\\033[H\\033[2Jframe %d of 300\\n" $i; sleep 0.01; done; sleep 30'`);
    await until(() => paneScreen(session).join('\n').includes('frame'), 8_000, 'the burst to start');
    // The browser falls behind mid-burst, asks for a snapshot, and every byte it
    // sees afterwards is dropped - including the final frame.
    model.dropping = true;
    streamer.requestSnapshot(session);
    await until(() => paneScreen(session).join('\n').includes('frame 300 of 300'), 15_000, 'the burst to finish');
    await until(() => model.screen().join('\n').includes('frame 300 of 300'), 6_000, 'the settled snapshot to repaint the final frame');
    await expectSameAsPane();
  });

  it('a stream that never goes quiet (yes) still delivers a snapshot, and the screen is exact once it stops', async () => {
    await start(`bash --norc --noprofile -c 'PS1="$ " bash --norc --noprofile -i'`);
    typeLiteral('yes flood-line');
    tmux('send-keys', '-t', session, 'Enter');
    await sleep(800);
    const requestedAt = Date.now();
    model.dropping = true;
    streamer.requestSnapshot(session);
    await until(() => model.fullFrames >= 2, 8_000, 'a snapshot while the flood runs');
    const flooded = Date.now() - requestedAt;
    console.log(JSON.stringify({ msToSnapshotUnderFlood: flooded }));
    expect(flooded).toBeLessThan(4_000);
    tmux('send-keys', '-t', session, 'C-c');
    await sleep(1_200);
    model.dropping = false;
    await expectSameAsPane();
  });
});
