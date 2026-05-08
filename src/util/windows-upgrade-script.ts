import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Cleanup script — kept as cmd.exe because it's a 4-line idempotent
 *  rmdir invoked from a wscript wrapper.  No control flow, no parens,
 *  no timeout — just ping for the 120 s settle and a single rmdir. */
export function buildWindowsCleanupScript(scriptDir: string): string {
  void scriptDir;
  return `@echo off\r
chcp 65001 >nul 2>&1\r
setlocal\r
rem ping-based sleep: works when launched via wscript (no console for stdin),\r
rem unlike "timeout /t N /nobreak" which aborts with "Input redirection is\r
rem not supported" and returns immediately.  -n 121 ≈ 120 s wait.\r
ping -n 121 127.0.0.1 >nul 2>&1\r
for %%I in ("%~dp0.") do set "SCRIPT_DIR=%%~fI"\r
rmdir /s /q "%SCRIPT_DIR%"\r
`;
}

/** VBS wrapper that runs the cleanup cmd in a hidden window (no taskbar flash).
 *  `On Error Resume Next` ensures no error dialog pops up. */
export function buildWindowsCleanupVbs(cleanupPath: string): string {
  return `On Error Resume Next\r\nSet WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run """${cleanupPath}""", 0, False\r\n`;
}

/** Build a VBS launcher that runs `<nodeExe> <runner.mjs> <args...>`
 *  hidden + detached.  This replaces the historical pattern of
 *  wscript→VBS→batch.cmd by running Node directly — eliminating every
 *  cmd.exe parser quirk we kept hitting (paren-counting in if-blocks,
 *  `timeout /t` requiring a console, `del` silent failures, codepage
 *  issues with non-ASCII paths).  Node's fs APIs use the Windows
 *  wide-char API natively, so paths with Chinese / Cyrillic / etc.
 *  characters round-trip without encoding games.
 *
 *  Encoding: the caller MUST write the result as UTF-16 LE with BOM
 *  (encodeVbsAsUtf16).  wscript parses BOM-less files as the system
 *  codepage, which mangles non-ASCII paths in usernames and %TEMP%.
 *
 *  VBS quoting rules: backslashes are NOT escape characters in VBS,
 *  and `""` inside a string literal is one literal `"`.  So a path
 *  with backslashes embeds verbatim — no doubling, no escaping. */
export function buildWindowsUpgradeRunnerVbs(input: {
  nodeExe: string;
  runnerPath: string;
  args: readonly string[];
}): string {
  const { nodeExe, runnerPath, args } = input;
  // Each command-line token wraps in `""..""`: opens a string, embeds
  // a literal `"`, then the token, then closes with another literal `"`.
  // The OUTER `"` of the WshShell.Run argument is the literal pair we
  // generate at join time.
  const tokens = [nodeExe, runnerPath, ...args].map((s) => `""${s}""`);
  const cmdLine = tokens.join(' ');
  return [
    'On Error Resume Next',
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run "${cmdLine}", 0, False`,
    '',
  ].join('\r\n');
}

/** Resolve the absolute path to the bundled JS upgrade runner.
 *
 *  The `.mjs` file ships alongside this `.ts`'s compiled output via
 *  `scripts/copy-worker-bootstraps.mjs` (any `*.mjs` under `src/`
 *  gets copied to `dist/src/` after `tsc`).  Resolving via
 *  import.meta.url means the path works for any npm prefix layout
 *  (default %APPDATA%\npm, nvm, fnm, volta, system).
 *
 *  Caller MUST copy the file into a per-upgrade tmp dir BEFORE
 *  spawning it — otherwise the in-flight `npm install -g` will
 *  overwrite the runner out from under itself when the new version's
 *  files land at the same global path. */
export function resolveWindowsUpgradeRunnerPath(): string {
  // dist/src/util/windows-upgrade-script.js → same dir, .mjs sibling.
  const builtSibling = resolve(__dirname, 'windows-upgrade-runner.mjs');
  if (existsSync(builtSibling)) return builtSibling;
  // Dev fallback: running this file via tsx without a `npm run build`.
  // src/ has the source .mjs, but it's not yet copied to dist/.
  const devSrc = resolve(__dirname, '..', '..', 'src', 'util', 'windows-upgrade-runner.mjs');
  if (existsSync(devSrc)) return devSrc;
  // Last resort — return the expected path even if missing so the
  // caller can fail loudly with a "file not found" instead of a silent
  // wrong-path bug.
  return builtSibling;
}
