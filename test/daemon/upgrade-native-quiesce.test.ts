import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Models the production SIGBUS: two crashes at the same relative offset
 * 0xe05e0 inside `node_datachannel.node (deleted)`, addr2line landing in
 * rtc::Description::Media::RtpMap's copy constructor.
 *
 * The chain is an ORDERING fault, not a logic fault. The old daemon still has
 * the native addon mapped; the detached upgrade replaces the global package —
 * and therefore that addon file — IN PLACE; the daemon then restarts and its
 * shutdown path finally runs the direct-transfer cleanup. By then the pages
 * behind the live mapping belong to a different file, so the first call back
 * into the addon faults.
 *
 * `import()` is ESM-cached, so "do not re-import after quiesce" is NOT the
 * invariant and a guard built on it would fix nothing. The invariant is: once
 * the addon file may have been replaced, NOTHING may call into it again.
 *
 * The fake native module below encodes exactly that: after a replacement
 * marker exists, any entry into it aborts the child, the same way the real
 * addon faults. No npm global is touched and no real package is installed.
 */
function runChild(order: 'replace_then_cleanup' | 'cleanup_then_replace'): { code: number; signal: string | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'imcodes-quiesce-red-'));
  const marker = join(dir, 'addon-replaced.marker');
  const fakeNative = join(dir, 'fake-native.mjs');
  const child = join(dir, 'child.mjs');

  writeFileSync(fakeNative, `
import { existsSync } from 'node:fs';
const MARKER = ${JSON.stringify(marker)};
// Any entry into the addon after its file was replaced is the fault site.
function enter(what) {
  if (existsSync(MARKER)) {
    process.stderr.write('FAULT: entered native ' + what + ' after replacement\\n');
    process.exit(134); // stand-in for SIGBUS on a replaced mapping
  }
}
let cb = null;
export function onEvent(fn) { enter('onEvent'); cb = fn; }
export function fire() { enter('callback'); cb?.(); }
export function cleanup() { enter('cleanup'); cb = null; }
`);

  writeFileSync(child, `
import { writeFileSync } from 'node:fs';
const native = await import(${JSON.stringify(fakeNative)});
native.onEvent(() => {});
const replace = () => writeFileSync(${JSON.stringify(marker)}, 'replaced');
const quiesce = () => native.cleanup();
${order === 'replace_then_cleanup'
    ? '// Today: the upgrade replaces the addon, THEN shutdown cleans up.\nreplace();\nquiesce();'
    : '// Required: quiesce to completion FIRST, only then replace.\nquiesce();\nreplace();'}
process.stdout.write('child completed\\n');
`);

  try {
    const output = execFileSync(process.execPath, [child], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, signal: null, output };
  } catch (error) {
    const e = error as { status?: number; signal?: string | null; stderr?: string; stdout?: string };
    return { code: e.status ?? -1, signal: e.signal ?? null, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('native addon quiesce must precede any package replacement', () => {
  it('control: quiescing before replacement completes cleanly', () => {
    const ok = runChild('cleanup_then_replace');
    expect(ok.output, 'the required ordering must not fault').toContain('child completed');
    expect(ok.code).toBe(0);
  }, 60_000);

  it('reproduces the fault: replacing the addon before quiesce makes cleanup fault', () => {
    const bad = runChild('replace_then_cleanup');
    // This is today's production ordering: upgrade replaces the global package
    // while the addon is still mapped, and the shutdown cleanup runs afterwards.
    expect(
      bad.output,
      'entering the native addon after its file was replaced must be detectable, '
      + 'and today the upgrade path performs exactly that ordering',
    ).toContain('FAULT: entered native cleanup after replacement');
    expect(bad.code).not.toBe(0);
  }, 60_000);
});
