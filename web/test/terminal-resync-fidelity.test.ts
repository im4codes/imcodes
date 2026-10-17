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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 20_000, label = 'condition'): Promise<void> {
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
  /** A browser that is slow to apply what it received: raw bytes reach xterm this many ms after they arrived. */
  constructor(private readonly rawLagMs = 0) {}

  private write(data: string | Uint8Array): void {
    this.chain = this.chain.then(() => new Promise<void>((resolve) => this.term.write(data, resolve)));
  }
  raw(data: Buffer): void {
    if (this.dropping) return;
    const bytes = new Uint8Array(data);
    if (this.rawLagMs <= 0) { this.write(bytes); return; }
    // Queued in arrival order behind the lag, so the order of writes is the order of arrival.
    this.chain = this.chain.then(() => sleep(this.rawLagMs)).then(() => new Promise<void>((resolve) => this.term.write(bytes, resolve)));
  }
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

/**
 * The pane's screen and cursor in ONE tmux invocation: tmux runs the commands of one invocation back to back, so the two describe the
 * same instant. Two separate calls (what this used to be) can straddle a byte of output and pair a screen with a cursor that never
 * existed together.
 */
function paneObservation(session: string): { screen: string[]; cursor: [number, number]; title: string } {
  const marker = '@@IMCODES-PANE-META@@';
  const out = tmux('capture-pane', '-p', '-t', session, ';', 'display-message', '-p', '-t', session, `${marker}#{cursor_x},#{cursor_y},#{pane_title}`);
  const at = out.indexOf(marker);
  const rows = out.slice(0, at).split('\n').slice(0, ROWS).map((line) => line.trimEnd());
  while (rows.length < ROWS) rows.push('');
  const [x, y, ...title] = out.slice(at + marker.length).trim().split(',');
  return { screen: rows, cursor: [Number(x), Number(y)], title: title.join(',') };
}
const paneScreen = (session: string): string[] => paneObservation(session).screen;

describe.skipIf(SKIP)('terminal resync fidelity (real tmux, real streamer, real xterm)', { timeout: 90_000, retry: 2 }, () => {
  let session: string;
  let streamer: TerminalStreamer;
  let model: BrowserModel;
  let unsubscribe: () => void;

  const start = async (command: string, rawLagMs = 0) => {
    tmux('new-session', '-d', '-s', session, '-x', String(COLS), '-y', String(ROWS), command);
    streamer = new TerminalStreamer();
    model = new BrowserModel(rawLagMs);
    unsubscribe = streamer.subscribe({
      sessionName: session,
      send: (diff) => model.diff(diff),
      sendRaw: (data) => model.raw(data),
    });
    await until(() => model.fullFrames >= 1, 20_000, 'the first-paint snapshot');
  };
  const typeLiteral = (text: string) => tmux('send-keys', '-t', session, '-l', text);
  /** The browser drops bytes, asks for a snapshot, and resumes once it arrives. */
  const loseBytesAndResync = async (whileDropping?: () => Promise<void>) => {
    model.dropping = true;
    if (whileDropping) await whileDropping();
    const before = model.fullFrames;
    streamer.requestSnapshot(session);
    await until(() => model.fullFrames > before, 20_000, 'the resync snapshot');
  };
  /**
   * The model must END UP equal to the pane (screen and cursor). Polled with a bounded timeout rather than after a fixed sleep (how
   * long the last bytes and the settle snapshot take depends on the machine).
   *
   * Every verdict is on ONE atomic pane observation, taken after the model has applied everything it was handed, and the assertion
   * reads that same observation. Comparing a first reading and then asserting on a second one (the old shape) let the pane move on
   * between the two: with the last output a newline that arrives after a pause, the check passed on the state before the newline and
   * the assertion failed on the state after it.
   */
  const expectSameAsPane = async () => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      await model.settled();
      const observed = paneObservation(session);
      const sameNow = JSON.stringify([model.screen(), model.cursor()]) === JSON.stringify([observed.screen, observed.cursor]);
      if (sameNow || Date.now() >= deadline) {
        expect(model.screen()).toEqual(observed.screen);
        expect(model.cursor()).toEqual(observed.cursor);
        return;
      }
      await sleep(100);
    }
  };
  /**
   * An in-band barrier: the program sets the pane title as its LAST output. tmux parses the stream in order, so once the title is
   * `title` every byte before it has been applied to the pane's screen and cursor - unlike "the last text is visible", which holds
   * while a newline that follows it is still on its way.
   */
  const untilPaneTitle = (title: string) => until(() => paneObservation(session).title === title, 20_000, `the program to set the pane title to ${title}`);

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
    await until(() => paneScreen(session).includes('hello'), 20_000, 'the first command to print its output');
    await loseBytesAndResync();
    typeLiteral('echo typed-after-resync');
    await until(() => paneScreen(session).join('\n').includes('$ echo typed-after-resync'), 20_000, 'the typed text to be echoed at the prompt');
    await expectSameAsPane();
    expect(model.screen().join('\n')).toContain('$ echo typed-after-resync');
  });

  /**
   * The counter's last output is a newline that comes AFTER everything the browser and the pane agree on: "count 60" is on screen
   * (cursor right after it) and the program then waits at a gate. The gate is opened right after a moment at which model and pane
   * were seen to agree - exactly when a verdict that reads the pane twice would pass on the first reading and fail on the second, as
   * happened on CI (`expected [ 11, 1 ] to deeply equal [ 0, 2 ]`, three attempts in a row, each ending the moment the counter did).
   * `rawLagMs` is a browser that applies bytes that long after receiving them.
   */
  const counterAfterResync = async (rawLagMs: number) => {
    const gateDir = mkdtempSync(join(tmpdir(), 'imcodes-resync-gate-'));
    const gate = join(gateDir, 'open');
    try {
      await start(`bash --norc --noprofile -c 'echo header; for i in $(seq 1 60); do printf "\\rcount %d   " $i; sleep 0.05; done; while [ ! -e ${gate} ]; do sleep 0.005; done; echo; printf "\\033]2;COUNTER-DONE\\007"; sleep 30'`, rawLagMs);
      await until(() => Number(/count (\d+)/.exec(paneScreen(session).join('\n'))?.[1] ?? 0) >= 10, 20_000, 'the counter to be running'); // a value stays on screen for 50 ms: "reached", not "equal to"
      await loseBytesAndResync();
      // Everything but the final newline is out: wait until the model shows exactly what the pane shows, cursor right after "count 60".
      await until(async () => {
        await model.settled();
        const observed = paneObservation(session);
        return observed.cursor[0] === 11 && observed.cursor[1] === 1
          && JSON.stringify([model.screen(), model.cursor()]) === JSON.stringify([observed.screen, observed.cursor]);
      }, 30_000, 'model and pane to agree with the counter finished and the program at its gate');
      writeFileSync(gate, ''); // the newline is now in flight
      await untilPaneTitle('COUNTER-DONE');
      await expectSameAsPane();
      expect(model.screen().join('\n')).toContain('count 60');
      expect(model.cursor()).toEqual([0, 2]); // on the row below the counter, where the final newline left it
    } finally {
      rmSync(gateDir, { recursive: true, force: true });
    }
  };
  it('a carriage-return counter keeps updating on its own row after a resync (the final newline follows a moment of agreement)', () => counterAfterResync(0));
  it('... also when the browser applies bytes 40 ms after it received them', () => counterAfterResync(40));

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
    await until(() => model.screen().join('\n').includes('ALT-PAGE-1'), 20_000, 'the application to draw page 1');
    // Resync while the application owns the alternate screen.
    await loseBytesAndResync();
    expect(model.screen().join('\n')).toContain('ALT-PAGE-1');
    await until(() => paneScreen(session).join('\n').includes('AFTER-EXIT'), 25_000, 'the application to exit');
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
    await until(() => paneScreen(session).join('\n').includes('frame'), 20_000, 'the burst to start');
    // The browser falls behind mid-burst, asks for a snapshot, and every byte it
    // sees afterwards is dropped - including the final frame.
    model.dropping = true;
    streamer.requestSnapshot(session);
    await until(() => paneScreen(session).join('\n').includes('frame 300 of 300'), 30_000, 'the burst to finish');
    await until(() => model.screen().join('\n').includes('frame 300 of 300'), 20_000, 'the settled snapshot to repaint the final frame');
    await expectSameAsPane();
  });

  it('a stream that never goes quiet (yes) still delivers a snapshot, and the screen is exact once it stops', async () => {
    await start(`bash --norc --noprofile -c 'PS1="$ " bash --norc --noprofile -i'`);
    typeLiteral('yes flood-line');
    tmux('send-keys', '-t', session, 'Enter');
    await until(() => paneScreen(session).filter(Boolean).length >= ROWS - 1, 20_000, 'the flood to fill the screen');
    const requestedAt = Date.now();
    model.dropping = true;
    streamer.requestSnapshot(session);
    // Bounded by events, not by a tight clock: on a loaded machine one capture-pane
    // under the flood can itself take seconds. The deterministic bound (deadline +
    // ONE capture, not N captures) is pinned in terminal-streamer-resync.test.ts
    // with controlled capture durations; here we prove it really happens.
    await until(() => model.fullFrames >= 2, 30_000, 'a snapshot while the flood runs');
    console.log(JSON.stringify({ msToSnapshotUnderFlood: Date.now() - requestedAt }));
    tmux('send-keys', '-t', session, 'C-c');
    // The prompt is the last thing the shell prints after the flood, and tmux parses in order: once it is the last row, nothing of the flood is left.
    await until(() => paneScreen(session).filter(Boolean).at(-1) === '$', 20_000, 'the shell prompt after the flood');
    model.dropping = false;
    await expectSameAsPane();
  });
});
