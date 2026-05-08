import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  buildWindowsCleanupScript,
  buildWindowsCleanupVbs,
  buildWindowsUpgradeRunnerVbs,
  resolveWindowsUpgradeRunnerPath,
} from '../../src/util/windows-upgrade-script.js';

describe('buildWindowsCleanupScript', () => {
  it('generates a standalone cleanup cmd script', () => {
    const script = buildWindowsCleanupScript('C:\\Temp\\imcodes-upgrade-123');
    expect(script).toContain('@echo off');
    expect(script).toContain('chcp 65001 >nul 2>&1');
    // ping-based sleep — `timeout` fails under wscript-spawned cmd
    // because there's no console for stdin.
    expect(script).toContain('ping -n 121 127.0.0.1 >nul 2>&1');
    expect(script).toContain('for %%I in ("%~dp0.") do set "SCRIPT_DIR=%%~fI"');
    expect(script).toContain('rmdir /s /q "%SCRIPT_DIR%"');
  });

  it('NEVER uses `timeout /t` (regression: fails when launched via wscript)', () => {
    const script = buildWindowsCleanupScript('C:\\Temp\\imcodes-upgrade-123');
    expect(script).not.toMatch(/timeout \/t \d+/);
  });
});

describe('buildWindowsCleanupVbs', () => {
  it('generates a VBS that runs cleanup hidden (window style 0)', () => {
    const vbs = buildWindowsCleanupVbs('C:\\Temp\\cleanup.cmd');
    expect(vbs).toContain('CreateObject("WScript.Shell")');
    expect(vbs).toContain('"C:\\Temp\\cleanup.cmd"');
    expect(vbs).toContain(', 0, False');
  });

  it('uses On Error Resume Next so wscript never pops up an error dialog', () => {
    const vbs = buildWindowsCleanupVbs('C:\\Temp\\cleanup.cmd');
    expect(vbs).toContain('On Error Resume Next');
  });

  it('handles non-ASCII paths in the cleanup target', () => {
    const vbs = buildWindowsCleanupVbs('C:\\Users\\测试用户A\\Temp\\cleanup.cmd');
    expect(vbs).toContain('测试用户A');
  });
});

// ── New JS-runner-based upgrade VBS ────────────────────────────────────────

describe('buildWindowsUpgradeRunnerVbs', () => {
  // Why JS instead of cmd.exe batch:
  //   - cmd.exe parses if-blocks by counting parens; literal `(` inside
  //     echo args silently terminates the block (2026-05-07 incident).
  //   - `timeout /t N /nobreak` aborts under wscript-spawned cmd because
  //     stdin is missing.
  //   - `del` returns 0 on sharing-violation / AV-scan races.
  //   - chcp 65001 only takes effect AFTER the file's first lines parse,
  //     so non-ASCII bytes in early lines get reinterpreted as OEM.
  //
  // Node.js fs APIs use the Windows wide-char API natively, so paths
  // with non-ASCII characters round-trip cleanly with no codepage games.
  const INPUT = {
    nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
    runnerPath: 'C:\\Temp\\imcodes-upgrade-123\\upgrade.mjs',
    args: [
      'C:\\Temp\\imcodes-upgrade-123\\upgrade.log',
      'C:\\Program Files\\nodejs\\npm.cmd',
      'imcodes@1.2.3',
      '1.2.3',
      'C:\\Temp\\imcodes-upgrade-123',
    ],
  };

  it('generates a hidden, fire-and-forget WshShell.Run line', () => {
    const vbs = buildWindowsUpgradeRunnerVbs(INPUT);
    expect(vbs).toContain('CreateObject("WScript.Shell")');
    expect(vbs).toContain('WshShell.Run');
    // window style 0 = hidden, bWaitOnReturn = False = fire-and-forget
    expect(vbs).toContain(', 0, False');
  });

  it('uses On Error Resume Next so wscript never pops up an error dialog', () => {
    const vbs = buildWindowsUpgradeRunnerVbs(INPUT);
    expect(vbs).toContain('On Error Resume Next');
  });

  it('quotes node, runner path, and every arg with VBS-style "" doubling', () => {
    // VBS escape rule: `""` inside a string literal is one literal `"`.
    // Each token wraps in `""..""` so the cmd line reaching Windows is:
    //   "C:\Program Files\nodejs\node.exe" "C:\...\upgrade.mjs" "arg1" ...
    // (necessary because the node and npm paths contain spaces).
    const vbs = buildWindowsUpgradeRunnerVbs(INPUT);
    expect(vbs).toContain('""C:\\Program Files\\nodejs\\node.exe""');
    expect(vbs).toContain('""C:\\Temp\\imcodes-upgrade-123\\upgrade.mjs""');
    expect(vbs).toContain('""imcodes@1.2.3""');
  });

  it('embeds non-ASCII paths verbatim (Chinese/Cyrillic/etc round-trip)', () => {
    // VBS does NOT use \ as an escape char.  Backslashes pass through
    // literally, and there's no codepage conversion if the file is
    // saved as UTF-16 LE with BOM (encodeVbsAsUtf16).  So a Chinese
    // %USERPROFILE% should embed verbatim with no doubling, escaping,
    // or normalization.  This is the opposite of the kill-daemon.mjs
    // bug we fixed on 2026-05-07 where backslash-doubling broke paths.
    const cn = buildWindowsUpgradeRunnerVbs({
      nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
      runnerPath: 'C:\\Users\\张三\\AppData\\Local\\Temp\\imcodes-upgrade-X\\upgrade.mjs',
      args: ['C:\\Users\\张三\\.imcodes\\upgrade.log'],
    });
    expect(cn).toContain('张三');
    // No double-backslash leakage.
    expect(cn).not.toContain('\\\\Users');
  });

  it('passes args in the order the runner expects (logFile, npmCmd, pkgSpec, targetVer, scriptDir)', () => {
    const vbs = buildWindowsUpgradeRunnerVbs(INPUT);
    const cmdLineLine = vbs.split(/\r?\n/).find((l) => l.startsWith('WshShell.Run'));
    expect(cmdLineLine).toBeDefined();
    // Strip the VBS doubled quotes so we can compare token order against
    // the runner's process.argv expectations.
    const stripped = (cmdLineLine ?? '').replace(/""/g, '"');
    const logIdx = stripped.indexOf('upgrade.log');
    const npmIdx = stripped.indexOf('npm.cmd');
    const pkgIdx = stripped.indexOf('imcodes@1.2.3');
    expect(logIdx).toBeGreaterThan(-1);
    expect(logIdx).toBeLessThan(npmIdx);
    expect(npmIdx).toBeLessThan(pkgIdx);
  });

  it('NEVER references cmd.exe — the entire upgrade is now JS', () => {
    // Regression guard: any new code that smuggles a cmd.exe call back
    // into the upgrade flow re-introduces the parser quirks we just
    // escaped (paren-counting, timeout-needs-stdin, codepage issues).
    const vbs = buildWindowsUpgradeRunnerVbs(INPUT);
    expect(vbs.toLowerCase()).not.toContain('cmd.exe');
    expect(vbs).not.toContain('chcp ');
    expect(vbs).not.toContain('@echo');
    expect(vbs).not.toContain('setlocal');
  });
});

// ── Bundled JS runner ──────────────────────────────────────────────────────

describe('windows-upgrade-runner.mjs (bundled JS upgrade runner)', () => {
  it('exists at the resolved path and is non-empty', () => {
    const runnerPath = resolveWindowsUpgradeRunnerPath();
    expect(existsSync(runnerPath), `runner missing at ${runnerPath}`).toBe(true);
    const src = readFileSync(runnerPath, 'utf8');
    expect(src.length).toBeGreaterThan(500);
  });

  it('uses Node fs APIs (NOT cmd.exe / batch) for filesystem ops', () => {
    const src = readFileSync(resolveWindowsUpgradeRunnerPath(), 'utf8');
    // Real Node imports — proves it's actually JS, not a string template.
    expect(src).toContain("from 'node:child_process'");
    expect(src).toContain("from 'node:fs'");
    // Lock file ops via Node fs, not `del` / `echo > %UPGRADE_LOCK%`.
    expect(src).toMatch(/unlinkSync|rmSync/);
    expect(src).toContain('writeFileSync');
  });

  it('always clears upgrade.lock via top-level finally — even on uncaught throw', () => {
    // The invariant the cmd.exe version kept getting wrong: a paren-
    // counting bug or a goto-mismatch could leave the script exiting
    // outside any path that ran `del UPGRADE_LOCK`.  In JS, the .finally()
    // chained off main() guarantees clearLock() always runs.
    const src = readFileSync(resolveWindowsUpgradeRunnerPath(), 'utf8');
    expect(src).toMatch(/main\(\s*\)\s*\.\s*catch[\s\S]*\.\s*finally/);
    expect(src).toContain('clearLock()');
  });

  it('caps NODE_OPTIONS heap at 4 GB (was 16 GB and accumulated across upgrades)', () => {
    // Regression: a previous cmd-version mutated %NODE_OPTIONS% via
    // `set "NODE_OPTIONS=%NODE_OPTIONS% --max-old-space-size=16384"`.
    // The setlocal env got inherited by the relaunched daemon, so each
    // upgrade appended one more flag.  After ~38 cycles V8 tried to
    // reserve a 16 GB heap on a tight VAS budget and `npm install`
    // crashed with MemoryChunk allocation failed during deserialization.
    //
    // The JS version passes a fresh env object to spawnSync (no
    // mutation of process.env), so accumulation is impossible.
    const src = readFileSync(resolveWindowsUpgradeRunnerPath(), 'utf8');
    expect(src).toContain('--max-old-space-size=4096');
    expect(src).not.toContain('--max-old-space-size=16384');
  });

  it('uses --ignore-scripts on the npm install (sharp install hook is unreliable)', () => {
    const src = readFileSync(resolveWindowsUpgradeRunnerPath(), 'utf8');
    expect(src).toContain('--ignore-scripts');
    expect(src.toLowerCase()).toContain('sharprepair');
  });

  it('does NOT use cmd.exe `timeout /t` for sleeps', () => {
    const src = readFileSync(resolveWindowsUpgradeRunnerPath(), 'utf8');
    // Atomics.wait is the synchronous JS sleep we use.  No cmd timeout.
    expect(src).toContain('Atomics.wait');
    expect(src).not.toMatch(/timeout \/t \d+/);
  });

  it('parses argv positionally (logFile, npmCmd, pkgSpec, targetVer, scriptDir)', () => {
    const src = readFileSync(resolveWindowsUpgradeRunnerPath(), 'utf8');
    expect(src).toContain('process.argv[2]');
    expect(src).toContain('process.argv[3]');
    expect(src).toContain('process.argv[4]');
    expect(src).toContain('process.argv[5]');
    expect(src).toContain('process.argv[6]');
  });
});
