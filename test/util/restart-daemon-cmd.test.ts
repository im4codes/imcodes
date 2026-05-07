import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Pins the invariants of `scripts/restart-daemon.cmd` — the dev-only Windows
 * helper that rebuilds + relinks + restarts the local imcodes daemon.
 *
 * Why: the file is hand-maintained (not generated), so it can drift in ways
 * that break silently in production-like Windows environments.  Several
 * trap classes have already cost us full restart cycles to debug:
 *   - Unicode em-dashes / box-drawing chars in comments BEFORE `chcp 65001`
 *     get re-interpreted as OEM bytes and break the parser.
 *   - LF (not CRLF) line endings cause cmd.exe to occasionally parse tokens
 *     across lines, especially inside `if (...)` blocks.
 *   - `timeout /t N` aborts under wscript-spawned cmd because there's no
 *     console for stdin.  ping must be used instead.
 *   - `imcodes service restart --no-build` rejects win32; we must use the
 *     standalone `imcodes restart` which routes through ensureDaemonRunning.
 *
 * These tests run in both Windows CI jobs.
 */

const CMD_PATH = join(__dirname, '..', '..', 'scripts', 'restart-daemon.cmd');

function readCmd(): { text: string; bytes: Buffer } {
  const bytes = readFileSync(CMD_PATH);
  // Read as latin1 so byte-for-byte fidelity is preserved (UTF-8 reads
  // would normalize surrogate pairs).  Then assert ASCII separately.
  const text = bytes.toString('latin1');
  return { text, bytes };
}

describe('scripts/restart-daemon.cmd', () => {
  const { text, bytes } = readCmd();

  it('exists and is non-empty', () => {
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('is pure ASCII (no Unicode em-dashes, box-drawing, smart quotes)', () => {
    // chcp 65001 only applies AFTER the file has been parsed, so any
    // multi-byte UTF-8 in the comment header gets reinterpreted as OEM
    // bytes.  We lost a full restart cycle on a U+2014 in a comment.
    for (let i = 0; i < bytes.length; i += 1) {
      const b = bytes[i];
      if (b > 0x7f) {
        // Surface the offending byte with surrounding context.
        const start = Math.max(0, i - 20);
        const end = Math.min(bytes.length, i + 20);
        const ctx = bytes.subarray(start, end).toString('latin1');
        throw new Error(
          `non-ASCII byte 0x${b.toString(16)} at offset ${i}: "${ctx}"`,
        );
      }
    }
  });

  it('uses CRLF line endings throughout (cmd.exe parses LF inconsistently)', () => {
    // Walk every \n and assert the preceding byte is \r.  An LF without CR
    // means the file got auto-converted by git on a misconfigured Windows
    // checkout, or hand-edited in a tool that defaults to LF.
    for (let i = 0; i < bytes.length; i += 1) {
      if (bytes[i] === 0x0a /* LF */) {
        if (i === 0 || bytes[i - 1] !== 0x0d /* CR */) {
          const start = Math.max(0, i - 30);
          const ctx = bytes.subarray(start, i).toString('latin1');
          throw new Error(
            `bare LF at offset ${i} (preceded by: "${ctx}") — needs CRLF`,
          );
        }
      }
    }
  });

  it('switches to UTF-8 codepage early (after the comment header but before any path-using line)', () => {
    expect(text).toContain('chcp 65001 >nul 2>&1');
    const chcpIdx = text.indexOf('chcp 65001');
    const setlocalIdx = text.indexOf('setlocal');
    // chcp must come before setlocal so any path expansions happen in UTF-8
    expect(chcpIdx).toBeGreaterThan(-1);
    expect(setlocalIdx).toBeGreaterThan(chcpIdx);
  });

  it('uses REM comments only (NOT ::)', () => {
    // The `::` comment hack works at top level but breaks inside parenthesized
    // blocks.  Make `rem` the only comment style so future edits don't get
    // surprised when they paste a comment into a new if-block.
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('::')) {
        throw new Error(`forbidden :: comment style: ${line}`);
      }
    }
  });

  it('every echo INSIDE an if(...) block has NO literal parens', () => {
    // Same parser quirk as windows-upgrade-script.ts: cmd.exe inside
    // `if (...)` can eat ^-escaped parens.  Forbid all forms; use
    // `[...]` or `--...--` instead.
    const lines = text.split(/\r?\n/);
    let depth = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip rem-style comments (cmd ignores parens inside them).
      if (/^\s*rem\b/i.test(line)) {
        if (/\($/.test(trimmed)) depth += 1;
        if (/^\)/.test(trimmed)) depth = Math.max(0, depth - 1);
        continue;
      }
      if (/^\)/.test(trimmed)) depth = Math.max(0, depth - 1);
      if (depth > 0 && /^\s*echo /.test(line)) {
        expect(line, `paren in if-block echo: ${line}`).not.toMatch(/[()]/);
      }
      if (/\($/.test(trimmed)) depth += 1;
    }
  });

  it('uses `imcodes restart` (not `imcodes service restart` which rejects win32)', () => {
    // The .sh counterpart uses `imcodes service restart --no-build` which
    // explicitly rejects win32 with "Unsupported platform".  On Windows
    // we must call the standalone `imcodes restart` command which routes
    // through ensureDaemonRunning() in src/util/windows-daemon.ts.
    //
    // Strip rem-comments before checking — the comment header documents
    // the .sh behavior (mentioning the forbidden form on purpose).
    const codeLines = text
      .split(/\r?\n/)
      .filter((l) => !/^\s*rem\b/i.test(l))
      .join('\n');
    expect(codeLines).toMatch(/\bimcodes restart\b/);
    expect(codeLines).not.toMatch(/imcodes service restart/);
  });

  it('uses ping (not timeout /t) for sleeps — timeout aborts under wscript', () => {
    // `timeout /t N /nobreak` requires a real console for stdin.  When
    // launched via wscript -> cmd, the spawned cmd has NO console
    // attached, so timeout aborts immediately with "Input redirection
    // is not supported, exiting the process immediately."
    expect(text).not.toMatch(/timeout \/t \d+/);
    // At least one ping-based sleep should be present in the detached restart
    expect(text).toMatch(/ping -n \d+ 127\.0\.0\.1/);
  });

  it('spawns the actual restart fully detached (wscript -> VBS -> CMD)', () => {
    // The whole point of the .cmd is to dispatch a restart that survives
    // the death of the calling shell (which may itself be inside a
    // transport session managed by the daemon being restarted).
    // wscript runs hidden in its own process group; CMD is launched
    // from the VBS.  All three layers are required.
    expect(text).toContain('wscript');
    expect(text).toContain('CreateObject("WScript.Shell")');
    expect(text).toContain('WshShell.Run');
    expect(text).toMatch(/, 0, False/); // hidden + no-wait
  });

  it('runs `npm install` and `npm run build` and `npm link --force` BEFORE dispatching restart', () => {
    // The pre-build steps must succeed before the detached restart spawns.
    // Otherwise the new daemon launches with stale or broken artifacts.
    const installIdx = text.indexOf('call npm install');
    const buildIdx = text.indexOf('call npm run build');
    const linkIdx = text.indexOf('call npm link --force');
    const dispatchIdx = text.indexOf('start "" /b wscript');
    expect(installIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeGreaterThan(-1);
    expect(linkIdx).toBeGreaterThan(-1);
    expect(dispatchIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeLessThan(buildIdx);
    expect(buildIdx).toBeLessThan(linkIdx);
    expect(linkIdx).toBeLessThan(dispatchIdx);
  });

  it('aborts with non-zero exit when any pre-build step fails', () => {
    // Each pre-build step must check errorlevel and bail.  Otherwise a
    // failing build silently dispatches a stale restart.
    expect(text).toMatch(/npm install FAILED/);
    expect(text).toMatch(/build FAILED/);
    expect(text).toMatch(/npm link FAILED/);
    // Each failure path must `exit /b 1`
    const failExitCount = (text.match(/exit \/b 1/g) ?? []).length;
    expect(failExitCount).toBeGreaterThanOrEqual(3);
  });

  it('uses a per-run randomized tmp dir so concurrent restarts do not trample each other', () => {
    expect(text).toMatch(/%RANDOM%-%RANDOM%/);
    expect(text).toContain('imcodes-restart-daemon-%STAMP%');
  });

  it('inner detached cmd cleans up its tmp dir after a delay', () => {
    // Without cleanup, repeated restarts pile orphaned tmp dirs in
    // %TEMP%.  The detached cmd self-deletes after a 60s ping pause.
    expect(text).toMatch(/rmdir \/s \/q "%TMP_DIR%"/);
  });

  it('On Error Resume Next so wscript never pops up an error dialog', () => {
    // If anything goes wrong loading the inner CMD path, wscript would
    // otherwise show a modal error dialog under the user's session,
    // which is hostile in a transport-session-driven workflow.
    expect(text).toMatch(/On Error Resume Next/);
  });
});
