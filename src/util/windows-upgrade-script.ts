import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WINDOWS_UPGRADE_RUNNER_STAGED_FILES } from './windows-upgrade-runner-staged-files.js';
import { encodeCmdAsUtf8Bom, encodeVbsAsUtf16 } from './windows-launch-artifacts.js';

/** The filename used by the VBS launcher for the staged runner entrypoint. */
export const WINDOWS_UPGRADE_RUNNER_ENTRY_FILE = 'upgrade.mjs';

/**
 * Copy the Windows upgrade runner and its relative-import closure into the
 * per-upgrade temporary directory.  The returned path is the single source
 * of truth passed to the VBS launcher; callers must not reconstruct it.
 */
export function stageWindowsUpgradeRunner(scriptDir: string, runnerSrc: string): { runnerPath: string } {
  const runnerPath = join(scriptDir, WINDOWS_UPGRADE_RUNNER_ENTRY_FILE);
  const stagedFiles = [
    { relativePath: WINDOWS_UPGRADE_RUNNER_ENTRY_FILE, sourcePath: runnerSrc },
    ...WINDOWS_UPGRADE_RUNNER_STAGED_FILES.map((relativePath) => ({
      relativePath,
      sourcePath: resolve(dirname(runnerSrc), relativePath),
    })),
  ];
  for (const { relativePath, sourcePath } of stagedFiles) {
    const destinationPath = join(scriptDir, relativePath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    writeFileSync(destinationPath, readFileSync(sourcePath));
  }
  return { runnerPath };
}

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

/** Resolve the npm global prefix that owns a running packaged daemon.
 * A daemon may be installed under an isolated/custom prefix (nvm/fnm/volta,
 * or a test HOME).  npm's ambient `prefix -g` can point at a different
 * installation, so derive the prefix from `<prefix>/node_modules/imcodes/...`.
 */
export function resolveWindowsUpgradePrefix(runnerPath: string): string | null {
  const normalized = runnerPath.replaceAll('\\', '/');
  const marker = '/node_modules/imcodes/';
  const index = normalized.toLowerCase().lastIndexOf(marker);
  if (index <= 0) return null;
  const prefix = normalized.slice(0, index);
  return prefix || null;
}


/**
 * Stage the Windows upgrade runner into `scriptDir` and start it hidden and fully
 * detached (wscript -> node upgrade.mjs), exactly as the daemon's own upgrade does.
 * The daemon and `imcodes upgrade` share this one launcher: whoever asked for the
 * upgrade can exit, or be killed, without touching the install. Throws when the
 * runner cannot be staged (nothing has been started then).
 */
export function launchWindowsUpgrade(input: {
  scriptDir: string;
  logFile: string;
  pkgSpec: string;
  /** Pinned version, or `latest`. */
  targetVer: string;
  /** Registry base, or '-' for npm's ambient default. */
  registryArg: string;
  /** Running version for the `latest` downgrade guard; '' disables it (an explicit CLI request). */
  currentVer: string;
}): { runnerCopy: string } {
  const npmBin = join(dirname(process.execPath), 'npm.cmd');
  const npmCmd = existsSync(npmBin) ? npmBin : 'npm';
  const runnerSrc = resolveWindowsUpgradeRunnerPath();
  const npmPrefix = resolveWindowsUpgradePrefix(runnerSrc);
  // Stage the runner with its complete relative-import closure because npm can
  // replace the installed package while the upgrade is running.
  const runnerCopy = stageWindowsUpgradeRunner(input.scriptDir, runnerSrc).runnerPath;

  // The cleanup .cmd is still cmd.exe, but a 4-line idempotent rmdir with no control
  // flow. The runner self-cleans too; this covers a runner that dies before its finally.
  const cleanupPath = join(input.scriptDir, 'cleanup.cmd');
  const cleanupVbsPath = join(input.scriptDir, 'cleanup.vbs');
  writeFileSync(cleanupPath, encodeCmdAsUtf8Bom(buildWindowsCleanupScript(input.scriptDir)));
  writeFileSync(cleanupVbsPath, encodeVbsAsUtf16(buildWindowsCleanupVbs(cleanupPath)));

  const upgradeVbsPath = join(input.scriptDir, 'upgrade.vbs');
  writeFileSync(upgradeVbsPath, encodeVbsAsUtf16(buildWindowsUpgradeRunnerVbs({
    nodeExe: process.execPath,
    runnerPath: runnerCopy,
    args: [input.logFile, npmCmd, input.pkgSpec, input.targetVer, input.scriptDir, input.registryArg, input.currentVer, npmPrefix ?? ''],
  })));

  spawn('wscript', [upgradeVbsPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  spawn('wscript', [cleanupVbsPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return { runnerCopy };
}
