import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  UPGRADE_LOCK_FILE,
  encodeCmdAsUtf8Bom,
  encodeVbsAsUtf16,
  writeVbsLauncher,
  writeWatchdogCmd,
} from '../../src/util/windows-launch-artifacts.js';

// ── Mock fs so writeWatchdogCmd doesn't touch disk ─────────────────────────

/** Captures both string and Buffer writes — Buffers are decoded to text for assertions. */
const written: Record<string, string> = {};
const writtenRaw: Record<string, Buffer | string> = {};

function decodeWritten(content: Buffer | string): string {
  if (typeof content === 'string') return content;
  // UTF-16 LE BOM
  if (content[0] === 0xFF && content[1] === 0xFE) {
    return content.slice(2).toString('utf16le');
  }
  // UTF-8 BOM
  if (content[0] === 0xEF && content[1] === 0xBB && content[2] === 0xBF) {
    return content.slice(3).toString('utf8');
  }
  return content.toString('utf8');
}

vi.mock('fs/promises', () => ({
  writeFile: vi.fn(async (path: string, content: string | Buffer) => {
    writtenRaw[path] = content;
    written[path] = decodeWritten(content);
  }),
  mkdir: vi.fn(async () => undefined),
  stat: vi.fn(async () => ({ size: 0 })),
  truncate: vi.fn(async () => undefined),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn((path: string) => {
    // Simulate npm global shim exists
    if (path.endsWith('imcodes.cmd')) return true;
    return false;
  }),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(() => ''),
}));

/** Reset the existsSync mock to its default (returns true for shim paths)
 *  so that one test's mockReturnValue(false) doesn't bleed into the next. */
async function resetExistsSyncMock(): Promise<void> {
  const { existsSync } = await import('fs');
  (existsSync as ReturnType<typeof vi.fn>).mockImplementation((path: string) => path.endsWith('imcodes.cmd'));
}

describe('writeWatchdogCmd', () => {
  beforeEach(async () => {
    for (const k of Object.keys(written)) delete written[k];
    await resetExistsSyncMock();
    // Tests below assume a default-prefix layout under
    // `C:\Users\X\AppData\Roaming\npm`. Stub APPDATA so the
    // npmGlobalBin === `%APPDATA%\npm` detection picks the env-var form.
    // Tests that intentionally exercise the custom-prefix branch override
    // this with vi.stubEnv inside the test body.
    vi.stubEnv('APPDATA', 'C:\\Users\\X\\AppData\\Roaming');
  });

  it('generates watchdog with upgrade lock check', async () => {
    const paths = {
      nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
      imcodesScript: 'C:\\Users\\X\\AppData\\Roaming\\npm\\node_modules\\imcodes\\dist\\src\\index.js',
      watchdogPath: 'C:\\Users\\X\\.imcodes\\daemon-watchdog.cmd',
      vbsPath: 'C:\\Users\\X\\.imcodes\\daemon-launcher.vbs',
      logPath: 'C:\\Users\\X\\.imcodes\\watchdog.log',
    };

    await writeWatchdogCmd(paths);

    const cmd = written[paths.watchdogPath];
    expect(cmd).toBeDefined();

    // Must check lock file BEFORE launching daemon
    const lockCheck = cmd.indexOf('if exist');
    const launchCmd = cmd.indexOf('start --foreground');
    expect(lockCheck).toBeGreaterThan(-1);
    expect(launchCmd).toBeGreaterThan(lockCheck);

    // Lock file path must be in the check (now via %USERPROFILE% expansion
    // so cmd.exe handles non-ASCII usernames natively at runtime).
    expect(cmd).toContain('%USERPROFILE%\\.imcodes\\upgrade.lock');

    // When locked, should wait and loop back (not launch daemon)
    expect(cmd).toContain('Upgrade in progress, waiting');
    expect(cmd).toContain('goto loop');
  });

  it('emits the preflight self-heal line via the npm shim env-var form when the shim is installed', async () => {
    // The preflight (`imcodes-launch-preflight.cmd`) is the Windows-side
    // counterpart of `bin/imcodes-launch.sh` — it runs BEFORE every
    // daemon-launch attempt and reinstalls the pinned version when
    // `node_modules` is half-installed (commander/ws/etc. as empty
    // placeholder dirs). Without this line the watchdog only catches
    // PROCESS death, not module-load failures, so a power-off mid-
    // upgrade wedges the daemon in an infinite restart loop.
    //
    // Same env-var form as the launch line so non-ASCII usernames
    // never get embedded in the .cmd body.
    const { existsSync } = await import('fs');
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation(
      (p: string) => p.endsWith('imcodes.cmd') || p.endsWith('imcodes-launch-preflight.cmd'),
    );
    const paths = {
      nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
      imcodesScript: 'C:\\Users\\X\\AppData\\Roaming\\npm\\node_modules\\imcodes\\dist\\src\\index.js',
      watchdogPath: 'C:\\Users\\X\\.imcodes\\daemon-watchdog.cmd',
      vbsPath: 'C:\\Users\\X\\.imcodes\\daemon-launcher.vbs',
      logPath: 'C:\\Users\\X\\.imcodes\\watchdog.log',
    };
    await writeWatchdogCmd(paths);
    const cmd = written[paths.watchdogPath];
    // Preflight line must use env-var form, not absolute path.
    expect(cmd).toContain('call "%APPDATA%\\npm\\imcodes-launch-preflight.cmd"');
    // No absolute path leakage (would break under non-ASCII usernames
    // because of cmd.exe's UTF-8 ↔ ANSI roundtrip).
    expect(cmd).not.toContain('C:\\Users\\X\\AppData\\Roaming\\npm\\imcodes-launch-preflight');
    // Preflight output must go to the watchdog log so operators can
    // see what self-repair did.
    expect(cmd).toContain('imcodes-launch-preflight.cmd" >> "%USERPROFILE%\\.imcodes\\watchdog.log"');
    // Order: preflight line MUST come before the launch line each
    // iteration, otherwise we'd attempt a launch on a broken install
    // first.
    const preflightIdx = cmd.indexOf('imcodes-launch-preflight.cmd');
    const launchIdx = cmd.indexOf('start --foreground');
    expect(preflightIdx).toBeGreaterThan(-1);
    expect(launchIdx).toBeGreaterThan(preflightIdx);
  });

  it('skips the preflight line when the shim is not installed (graceful degradation for older versions)', async () => {
    // Older imcodes versions ship without the preflight bin entry, so
    // the npm shim doesn't exist on disk. Watchdog must NOT emit a
    // preflight line in that case — calling a missing shim would loop
    // an error per iteration. The next upgrade lands the shim and
    // step 3.5's launch-chain regen will rewrite the watchdog with
    // the preflight included.
    const { existsSync } = await import('fs');
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation(
      (p: string) => p.endsWith('imcodes.cmd'), // only the launch shim, no preflight
    );
    const paths = {
      nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
      imcodesScript: 'C:\\Users\\X\\AppData\\Roaming\\npm\\node_modules\\imcodes\\dist\\src\\index.js',
      watchdogPath: 'C:\\Users\\X\\.imcodes\\daemon-watchdog.cmd',
      vbsPath: 'C:\\Users\\X\\.imcodes\\daemon-launcher.vbs',
      logPath: 'C:\\Users\\X\\.imcodes\\watchdog.log',
    };
    await writeWatchdogCmd(paths);
    const cmd = written[paths.watchdogPath];
    expect(cmd).not.toContain('imcodes-launch-preflight');
    // Launch line still works as before.
    expect(cmd).toContain('call "%APPDATA%\\npm\\imcodes.cmd" start --foreground');
  });

  it('uses %APPDATA%\\npm\\imcodes.cmd via env-var expansion (no hardcoded path)', async () => {
    const paths = {
      nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
      imcodesScript: 'C:\\Users\\X\\AppData\\Roaming\\npm\\node_modules\\imcodes\\dist\\src\\index.js',
      watchdogPath: 'C:\\Users\\X\\.imcodes\\daemon-watchdog.cmd',
      vbsPath: 'C:\\Users\\X\\.imcodes\\daemon-launcher.vbs',
      logPath: 'C:\\Users\\X\\.imcodes\\watchdog.log',
    };

    await writeWatchdogCmd(paths);
    const cmd = written[paths.watchdogPath];

    // Should reference the shim via %APPDATA% so cmd.exe expands at runtime
    // (this is the only way non-ASCII usernames work without encoding loss).
    expect(cmd).toContain('%APPDATA%\\npm\\imcodes.cmd');
    expect(cmd).not.toContain('C:\\Users\\X\\AppData');
    expect(cmd).not.toContain('node_modules');
  });

  it('prefixes the launch line with `call` so the loop resumes after daemon exit', async () => {
    const paths = {
      nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
      imcodesScript: 'C:\\Users\\X\\AppData\\Roaming\\npm\\node_modules\\imcodes\\dist\\src\\index.js',
      watchdogPath: 'C:\\Users\\X\\.imcodes\\daemon-watchdog.cmd',
      vbsPath: 'C:\\Users\\X\\.imcodes\\daemon-launcher.vbs',
      logPath: 'C:\\Users\\X\\.imcodes\\watchdog.log',
    };
    await writeWatchdogCmd(paths);
    const cmd = written[paths.watchdogPath];
    // Without `call`, control hands off to the .cmd shim and never returns,
    // so the watchdog loop dies after the first daemon exit.
    expect(cmd).toContain('call "%APPDATA%\\npm\\imcodes.cmd" start --foreground');
  });

  it('uses %USERPROFILE% env-var expansion for the lock file path', async () => {
    const paths = {
      nodeExe: 'node.exe',
      imcodesScript: 'C:\\Users\\X\\AppData\\Roaming\\npm\\node_modules\\imcodes\\dist\\src\\index.js',
      watchdogPath: 'C:\\Users\\X\\.imcodes\\daemon-watchdog.cmd',
      vbsPath: 'C:\\Users\\X\\.imcodes\\daemon-launcher.vbs',
      logPath: 'C:\\Users\\X\\.imcodes\\watchdog.log',
    };
    await writeWatchdogCmd(paths);
    const cmd = written[paths.watchdogPath];
    expect(cmd).toContain('%USERPROFILE%\\.imcodes\\upgrade.lock');
    expect(cmd).toContain('%USERPROFILE%\\.imcodes\\watchdog.log');
  });

  it('falls back to node+script when shim not found', async () => {
    // Override existsSync to return false for shim
    const { existsSync } = await import('fs');
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const paths = {
      nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
      imcodesScript: 'C:\\dev\\imcodes\\dist\\src\\index.js',
      watchdogPath: 'C:\\Users\\X\\.imcodes\\daemon-watchdog.cmd',
      vbsPath: 'C:\\Users\\X\\.imcodes\\daemon-launcher.vbs',
      logPath: 'C:\\Users\\X\\.imcodes\\watchdog.log',
    };

    await writeWatchdogCmd(paths);
    const cmd = written[paths.watchdogPath];

    // Should fall back to direct node+script
    expect(cmd).toContain('node.exe');
    expect(cmd).toContain('index.js');
  });

  it('watchdog is an infinite loop with ping-based 5s retry', async () => {
    const paths = {
      nodeExe: 'node.exe',
      imcodesScript: 'C:\\npm\\node_modules\\imcodes\\dist\\src\\index.js',
      watchdogPath: 'out.cmd',
      vbsPath: 'out.vbs',
      logPath: 'out.log',
    };

    await writeWatchdogCmd(paths);
    const cmd = written[paths.watchdogPath];

    expect(cmd).toContain(':loop');
    expect(cmd).toContain('goto loop');
    // ping -n 6 127.0.0.1 ≈ 5 second wait — works in console-less wscript
    // child processes where `timeout` aborts immediately.
    expect(cmd).toContain('ping -n 6 127.0.0.1 >nul 2>&1');
  });

  it('NEVER uses `timeout /t` for sleep (regression: timeout fails under wscript)', async () => {
    // `timeout /t N /nobreak` requires a real console for stdin (it polls
    // keypresses to detect interrupt).  When the watchdog is launched via
    // wscript → WshShell.Run, the spawned cmd has NO console attached, so
    // `timeout` aborts immediately with "Input redirection is not
    // supported, exiting the process immediately." — meaning no actual
    // sleep happens.  Result: the watchdog spin-loops at full CPU and
    // logs thousands of "waiting..." lines per minute.  Use ping instead.
    const paths = {
      nodeExe: 'node.exe',
      imcodesScript: 'C:\\npm\\node_modules\\imcodes\\dist\\src\\index.js',
      watchdogPath: 'out.cmd',
      vbsPath: 'out.vbs',
      logPath: 'out.log',
    };
    await writeWatchdogCmd(paths);
    const cmd = written[paths.watchdogPath];
    expect(cmd).not.toMatch(/timeout \/t \d+/);
  });

  it('lock-wait state logs only ONCE on entry/exit, not every poll', async () => {
    // Regression: an earlier implementation logged "Upgrade in progress,
    // waiting..." inside a 5-second poll loop, which combined with the
    // `timeout`-fails-under-wscript bug filled the watchdog log with 25k+
    // lines in 12 minutes during a stuck-lock incident.  The new shape
    // uses two labels (`:wait_lock` for entry, `:wait_loop` for the poll
    // body) so the entry message logs once, then we poll silently every
    // 30 seconds, and log once more when the lock clears.
    const paths = {
      nodeExe: 'node.exe',
      imcodesScript: 'C:\\npm\\node_modules\\imcodes\\dist\\src\\index.js',
      watchdogPath: 'out.cmd',
      vbsPath: 'out.vbs',
      logPath: 'out.log',
    };
    await writeWatchdogCmd(paths);
    const cmd = written[paths.watchdogPath];
    expect(cmd).toContain(':wait_lock');
    expect(cmd).toContain(':wait_loop');
    // 30 s poll during lock-wait (vs 5 s after a clean daemon exit)
    expect(cmd).toContain('ping -n 31 127.0.0.1 >nul 2>&1');
    // Exactly one "waiting..." entry message (not inside the poll loop)
    const waitingHits = (cmd.match(/Upgrade in progress, waiting/g) ?? []).length;
    expect(waitingHits).toBe(1);
    // And exactly one "cleared" exit message
    expect(cmd).toContain('Upgrade lock cleared, resuming');
  });

  it('self-heals stuck upgrade.lock when older than 10 minutes', async () => {
    // Stable fix for daemon auto-upgrade: if the upgrade script crashes
    // before reaching its `:done` safety-net (the failure mode we hit
    // 2026-04-27 from a doubled-backslash path AND 2026-05-07 from
    // unescaped parens in an if-block echo), the lock would otherwise
    // strand the watchdog in :wait_loop forever.
    //
    // The watchdog now runs a tiny PowerShell probe each poll: if the
    // lock's mtime is >10 minutes old, remove it.  Real upgrades finish
    // in well under 10 minutes (npm install on a healthy connection is
    // ~1-3 min), so this cannot race with a live upgrade.
    const paths = {
      nodeExe: 'node.exe',
      imcodesScript: 'C:\\npm\\node_modules\\imcodes\\dist\\src\\index.js',
      watchdogPath: 'out.cmd',
      vbsPath: 'out.vbs',
      logPath: 'out.log',
    };
    await writeWatchdogCmd(paths);
    const cmd = written[paths.watchdogPath];

    // PowerShell probe must be present and check >10min mtime
    expect(cmd).toContain('powershell -NoProfile -NonInteractive');
    expect(cmd).toContain('LastWriteTime');
    expect(cmd).toContain('AddMinutes(-10)');
    expect(cmd).toContain('Remove-Item');

    // Two distinct exit-from-wait paths so the operator can tell them apart:
    //   - normal: "Upgrade lock cleared, resuming."
    //   - self-heal: "Upgrade lock was stale (>10min) — removed by watchdog self-heal."
    expect(cmd).toContain('Upgrade lock cleared, resuming');
    expect(cmd).toMatch(/Upgrade lock was stale.*removed by watchdog self-heal/);
    // ASCII-only — the watchdog .cmd file has a separate "no high bytes"
    // assertion further down, so the self-heal message must use ASCII
    // hyphens, not Unicode em-dashes.
    // The two exit paths are distinct labels — :lock_cleared (normal) and
    // a stale-removal block that falls through to `goto loop`.
    expect(cmd).toContain(':lock_cleared');
  });

  it('stale-lock probe runs INSIDE wait_loop, after the 30s sleep', async () => {
    // Order matters: we must ping-sleep first, then check the lock, then
    // run the stale probe.  If we probed BEFORE sleeping, every entry to
    // :wait_loop would re-check the mtime and could remove a lock that
    // was just barely placed by a slow-starting upgrade.
    const paths = {
      nodeExe: 'node.exe',
      imcodesScript: 'C:\\npm\\node_modules\\imcodes\\dist\\src\\index.js',
      watchdogPath: 'out.cmd',
      vbsPath: 'out.vbs',
      logPath: 'out.log',
    };
    await writeWatchdogCmd(paths);
    const cmd = written[paths.watchdogPath];

    const waitLoopIdx = cmd.indexOf(':wait_loop');
    const pingIdx = cmd.indexOf('ping -n 31', waitLoopIdx);
    const psProbeIdx = cmd.indexOf('powershell -NoProfile', waitLoopIdx);
    expect(waitLoopIdx).toBeGreaterThan(-1);
    expect(pingIdx).toBeGreaterThan(waitLoopIdx);
    expect(psProbeIdx).toBeGreaterThan(pingIdx);
  });
});

describe('writeVbsLauncher', () => {
  beforeEach(async () => {
    for (const k of Object.keys(written)) delete written[k];
    for (const k of Object.keys(writtenRaw)) delete writtenRaw[k];
    await resetExistsSyncMock();
  });

  it('runs watchdog CMD hidden (window style 0)', async () => {
    const paths = {
      nodeExe: '', imcodesScript: '', logPath: '',
      watchdogPath: 'C:\\Users\\X\\.imcodes\\daemon-watchdog.cmd',
      vbsPath: 'C:\\Users\\X\\.imcodes\\daemon-launcher.vbs',
    };

    await writeVbsLauncher(paths);
    const vbs = written[paths.vbsPath];

    expect(vbs).toContain('WshShell.Run');
    expect(vbs).toContain('daemon-watchdog.cmd');
    // Window style 0 = hidden
    expect(vbs).toContain(', 0, False');
  });

  it('writes VBS as UTF-16 LE with BOM (required for non-ASCII paths)', async () => {
    const paths = {
      nodeExe: '', imcodesScript: '', logPath: '',
      watchdogPath: 'C:\\Users\\用户测试\\.imcodes\\daemon-watchdog.cmd',
      vbsPath: 'C:\\Users\\用户测试\\.imcodes\\daemon-launcher.vbs',
    };

    await writeVbsLauncher(paths);
    const raw = writtenRaw[paths.vbsPath];

    // Must be a Buffer (not a string written via 'utf8' encoding)
    expect(Buffer.isBuffer(raw)).toBe(true);
    if (Buffer.isBuffer(raw)) {
      // First 2 bytes must be UTF-16 LE BOM
      expect(raw[0]).toBe(0xFF);
      expect(raw[1]).toBe(0xFE);
      // Decoded content must contain the Chinese path intact
      const decoded = raw.slice(2).toString('utf16le');
      expect(decoded).toContain('用户测试');
      expect(decoded).toContain('daemon-watchdog.cmd');
    }
  });

  it('uses On Error Resume Next so wscript never pops up an error dialog', async () => {
    const paths = {
      nodeExe: '', imcodesScript: '', logPath: '',
      watchdogPath: 'C:\\nonexistent\\path.cmd',
      vbsPath: 'C:\\Users\\X\\.imcodes\\daemon-launcher.vbs',
    };

    await writeVbsLauncher(paths);
    const vbs = written[paths.vbsPath];
    expect(vbs).toContain('On Error Resume Next');
  });
});

describe('encodeCmdAsUtf8Bom (deprecated)', () => {
  it('returns plain UTF-8 — cmd.exe does not understand BOMs in batch files', async () => {
    // Regression: a previous implementation prepended an EF BB BF BOM here.
    // cmd.exe parses the BOM as part of the first command on the first line,
    // so `[BOM]@echo off` becomes "[BOM]@echo is not a recognized command".
    // The function MUST NOT emit a BOM.
    const buf = encodeCmdAsUtf8Bom('@echo off\r\necho 测试用户\r\n');
    expect(buf[0]).not.toBe(0xEF);
    expect(buf[1]).not.toBe(0xBB);
    expect(buf[2]).not.toBe(0xBF);
    // Content is plain UTF-8
    expect(buf.toString('utf8')).toContain('测试用户');
    expect(buf.toString('utf8').startsWith('@echo off')).toBe(true);
  });
});

describe('encodeVbsAsUtf16', () => {
  it('prepends UTF-16 LE BOM (FF FE)', async () => {
    const buf = encodeVbsAsUtf16('WScript.Echo "测试用户"');
    expect(buf[0]).toBe(0xFF);
    expect(buf[1]).toBe(0xFE);
    const decoded = buf.slice(2).toString('utf16le');
    expect(decoded).toContain('测试用户');
  });
});

describe('writeWatchdogCmd encoding (regression: cmd.exe BOM bug)', () => {
  beforeEach(async () => {
    for (const k of Object.keys(written)) delete written[k];
    for (const k of Object.keys(writtenRaw)) delete writtenRaw[k];
    await resetExistsSyncMock();
  });

  it('writes watchdog .cmd WITHOUT a UTF-8 BOM', async () => {
    // REGRESSION GUARD — see fix(daemon-watchdog): the previous implementation
    // wrote a UTF-8 BOM at the start of the .cmd file.  cmd.exe doesn't strip
    // the BOM; instead it concatenates the BOM bytes with the next token,
    // producing `[BOM]@echo is not a recognized command`.  The watchdog
    // looped forever printing this error and never managed to start the
    // daemon.  The fix: write plain UTF-8 with no BOM.
    const paths = {
      nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
      imcodesScript: 'C:\\Users\\X\\AppData\\Roaming\\npm\\node_modules\\imcodes\\dist\\src\\index.js',
      watchdogPath: 'C:\\Users\\X\\.imcodes\\daemon-watchdog.cmd',
      vbsPath: 'C:\\Users\\X\\.imcodes\\daemon-launcher.vbs',
      logPath: 'C:\\Users\\X\\.imcodes\\watchdog.log',
    };
    await writeWatchdogCmd(paths);
    const raw = writtenRaw[paths.watchdogPath];

    // Either string (utf8) or Buffer is allowed, but the first 3 bytes
    // must NOT be the UTF-8 BOM.
    if (Buffer.isBuffer(raw)) {
      expect(raw[0]).not.toBe(0xEF);
    } else if (typeof raw === 'string') {
      expect(raw.charCodeAt(0)).not.toBe(0xFEFF);
    } else {
      throw new Error('writeWatchdogCmd produced no output');
    }

    // The first non-empty line must be exactly `@echo off` so cmd.exe
    // recognises it as the disable-echo directive.
    const decoded = written[paths.watchdogPath];
    const firstLine = decoded.split(/\r?\n/).find((line) => line.trim().length > 0);
    expect(firstLine).toBe('@echo off');
  });

  it('survives non-ASCII usernames by using %APPDATA% / %USERPROFILE% expansion (default prefix)', async () => {
    // The fix for non-ASCII paths is NOT to encode the bytes correctly —
    // it's to never bake the path into the file at all when the install
    // is at the default prefix.  cmd.exe expands env vars at runtime via
    // the OS native wide-char API, so the actual username encoding
    // doesn't matter.
    vi.stubEnv('APPDATA', 'C:\\Users\\用户测试\\AppData\\Roaming');
    const paths = {
      nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
      // Path with Chinese chars only matters for the SHIM detection probe.
      imcodesScript: 'C:\\Users\\用户测试\\AppData\\Roaming\\npm\\node_modules\\imcodes\\dist\\src\\index.js',
      watchdogPath: 'C:\\Users\\用户测试\\.imcodes\\daemon-watchdog.cmd',
      vbsPath: 'C:\\Users\\用户测试\\.imcodes\\daemon-launcher.vbs',
      logPath: 'C:\\Users\\用户测试\\.imcodes\\watchdog.log',
    };
    await writeWatchdogCmd(paths);
    const cmd = written[paths.watchdogPath];

    // The Chinese username MUST NOT appear inside the file.  Everything is
    // routed through %APPDATA% and %USERPROFILE%.
    expect(cmd).not.toContain('用户测试');
    expect(cmd).toContain('%APPDATA%\\npm\\imcodes.cmd');
    expect(cmd).toContain('%USERPROFILE%\\.imcodes\\watchdog.log');
  });

  it('uses ABSOLUTE shim path when npm prefix differs from %APPDATA%\\npm (nvm/fnm/custom)', async () => {
    // Regression: a previous implementation hardcoded `%APPDATA%\\npm\\imcodes.cmd`
    // for the launch line. When the user's npm prefix was elsewhere (nvm,
    // fnm, volta, system nodejs install, or any custom `npm config set
    // prefix`), the watchdog launched a stale shim left over from a prior
    // default-prefix install — bypassing the upgrade. Symptom: user runs
    // upgrade, npm install reports success, daemon "restart" still serves
    // the old version because it ran the wrong shim.
    vi.stubEnv('APPDATA', 'C:\\Users\\X\\AppData\\Roaming');
    const customPrefix = 'C:\\nvm-versions\\v20.11.0';
    const paths = {
      nodeExe: `${customPrefix}\\node.exe`,
      imcodesScript: `${customPrefix}\\node_modules\\imcodes\\dist\\src\\index.js`,
      watchdogPath: 'C:\\Users\\X\\.imcodes\\daemon-watchdog.cmd',
      vbsPath: 'C:\\Users\\X\\.imcodes\\daemon-launcher.vbs',
      logPath: 'C:\\Users\\X\\.imcodes\\watchdog.log',
    };
    await writeWatchdogCmd(paths);
    const cmd = written[paths.watchdogPath];

    // Watchdog must launch the shim that matches THIS install location,
    // not the default-prefix shim (which may not exist or be stale).
    expect(cmd).toContain(`call "${customPrefix}\\imcodes.cmd" start --foreground`);
    expect(cmd).not.toContain('%APPDATA%\\npm\\imcodes.cmd');
  });

  it('uses ABSOLUTE shim path when APPDATA env var is unset', async () => {
    // Defensive: if for some reason APPDATA isn't in the daemon's env
    // (extremely unusual on Windows but possible under stripped-down
    // service environments), fall back to the absolute path so the
    // upgrade can't silently route through a non-existent default prefix.
    vi.stubEnv('APPDATA', '');
    const paths = {
      nodeExe: 'C:\\node\\node.exe',
      imcodesScript: 'C:\\Users\\X\\AppData\\Roaming\\npm\\node_modules\\imcodes\\dist\\src\\index.js',
      watchdogPath: 'C:\\Users\\X\\.imcodes\\daemon-watchdog.cmd',
      vbsPath: 'C:\\Users\\X\\.imcodes\\daemon-launcher.vbs',
      logPath: 'C:\\Users\\X\\.imcodes\\watchdog.log',
    };
    await writeWatchdogCmd(paths);
    const cmd = written[paths.watchdogPath];
    expect(cmd).toContain('call "C:\\Users\\X\\AppData\\Roaming\\npm\\imcodes.cmd" start --foreground');
  });

  it('every line is plain ASCII (no embedded user paths)', async () => {
    // Belt-and-suspenders: scan every byte to ensure the watchdog file
    // contains no characters above 0x7F.  Anything above means we baked
    // a user path in by mistake — and that user path could be any
    // codepage on a real Windows machine.
    const paths = {
      nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
      imcodesScript: 'C:\\Users\\X\\AppData\\Roaming\\npm\\node_modules\\imcodes\\dist\\src\\index.js',
      watchdogPath: 'C:\\Users\\X\\.imcodes\\daemon-watchdog.cmd',
      vbsPath: 'C:\\Users\\X\\.imcodes\\daemon-launcher.vbs',
      logPath: 'C:\\Users\\X\\.imcodes\\watchdog.log',
    };
    await writeWatchdogCmd(paths);
    const cmd = written[paths.watchdogPath];
    for (let i = 0; i < cmd.length; i++) {
      expect(cmd.charCodeAt(i)).toBeLessThan(0x80);
    }
  });
});

describe('UPGRADE_LOCK_FILE', () => {
  it('is under .imcodes directory', async () => {
    expect(UPGRADE_LOCK_FILE).toContain('.imcodes');
    expect(UPGRADE_LOCK_FILE).toContain('upgrade.lock');
  });
});
