import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AIDESK_UI_LOG } from '../../shared/aidesk-ui-log.js';

// The aiDesk.to app's diagnostics and single-instance support (native/macos-remote-desktop/aidesk_ui_support.mm) is Objective-C++ for
// macOS: the real code is compiled with the host's clang++ and driven here. Skipped everywhere else (and where clang++ is missing).
const HAVE_COMPILER = process.platform === 'darwin' && spawnSync('clang++', ['--version']).status === 0;
const SOURCE = resolve(__dirname, '../../native/macos-remote-desktop');

let work = '';
let binary = '';

beforeAll(() => {
  if (!HAVE_COMPILER) return;
  work = realpathSync(mkdtempSync(join(tmpdir(), 'aidesk-ui-support-')));
  binary = join(work, 'driver');
  const compile = spawnSync('clang++', [
    '-std=c++20', '-fobjc-arc', '-framework', 'AppKit', '-framework', 'Foundation',
    `-I${SOURCE}`, join(SOURCE, 'aidesk_ui_support.mm'), join(SOURCE, 'aidesk_ui_support_test_main.mm'), '-o', binary,
  ], { encoding: 'utf8' });
  expect(compile.status, compile.stderr).toBe(0);
}, 120_000);

afterAll(() => { if (work) rmSync(work, { recursive: true, force: true }); });

const describeMac = HAVE_COMPILER ? describe : describe.skip;

function run(mode: string, home: string): { status: number | null; stdout: string } {
  mkdirSync(home, { recursive: true });
  const result = spawnSync(binary, [mode, home], { encoding: 'utf8', timeout: 30_000 });
  return { status: result.status, stdout: result.stdout };
}

describeMac('aidesk_ui_support: the watchdog and the log', () => {
  it('says so, with the phase, when the main thread does a blocking call (and the call is longer than the threshold)', () => {
    const result = run('blocked', join(work, 'home-blocked'));
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/process_start role=test/u);
    const blocked = /main_thread_(?:blocked|delay) ms=(\d+) phase=blocked_phase/u.exec(result.stdout);
    expect(blocked, result.stdout).not.toBeNull();
    expect(Number(blocked![1])).toBeGreaterThanOrEqual(250);
  });

  it('a main thread that keeps running logs no delay at all', () => {
    const result = run('quiet', join(work, 'home-quiet'));
    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/main_thread_/u);
  });

  it('is bounded: a log over the size limit is moved aside once, and one run writes at most the line limit', () => {
    const home = join(work, 'home-rotate');
    const rotated = run('rotate', home);
    expect(rotated.stdout).toContain('after_rotation');
    const directory = join(home, AIDESK_UI_LOG.DIRECTORY);
    expect(existsSync(join(directory, `${AIDESK_UI_LOG.FILE}.1`))).toBe(true);
    expect(statSync(join(directory, AIDESK_UI_LOG.FILE)).size).toBeLessThan(AIDESK_UI_LOG.MAX_BYTES);
    const flooded = run('flood', join(work, 'home-flood'));
    const lines = flooded.stdout.split('\n').filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(AIDESK_UI_LOG.MAX_LINES_PER_RUN);
    expect(lines.length).toBeGreaterThan(10);
    expect(readdirSync(join(work, 'home-flood', AIDESK_UI_LOG.DIRECTORY))).toContain(AIDESK_UI_LOG.FILE);
  });

  it('keeps no user name, path or URL in the log: event and phase names and numbers only', () => {
    const text = run('blocked', join(work, 'home-pii')).stdout;
    expect(text).not.toContain(work);
    expect(text).not.toMatch(/\/Users\/|https?:|127\.0\.0\.1/u);
    for (const line of text.split('\n').filter(Boolean)) expect(line).toMatch(/^\d+ [a-z_]+( [a-z_]+)?( ms=\d+)?( phase=[a-z_]+)? role=[a-z]+$/u);
  });
});

describeMac('aidesk_ui_support: one user-facing instance', () => {
  function startOwner(mode: 'claim' | 'claim-observe', home: string): { output: () => string; stop: () => void } {
    mkdirSync(home, { recursive: true });
    const child = spawn(binary, [mode, home]);
    let text = '';
    child.stdout.on('data', (chunk: Buffer) => { text += String(chunk); });
    return { output: () => text, stop: () => { child.kill('SIGKILL'); } };
  }

  async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('condition not reached');
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }

  it('the first process owns the role; a second one that nobody answers carries on without it, within the bounded wait', async () => {
    const home = join(work, 'home-claim');
    const owner = startOwner('claim', home);
    try {
      await until(() => owner.output().includes('claim=owner'));
      const started = Date.now();
      const second = run('claim', home);
      expect(second.stdout).toContain('claim=unlocked');
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      owner.stop();
    }
  });

  it('once the owner is gone the lock is free again', async () => {
    const home = join(work, 'home-claim-free');
    const owner = startOwner('claim', home);
    await until(() => owner.output().includes('claim=owner'));
    owner.stop();
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    expect(run('claim', home).stdout).toContain('claim=owner');
  });
});
