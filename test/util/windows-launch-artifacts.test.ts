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

  it('watchdog is an infinite loop with 5s retry', async () => {
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
    expect(cmd).toContain('timeout /t 5');
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

  it('survives non-ASCII usernames by using %APPDATA% / %USERPROFILE% expansion', async () => {
    // The fix for non-ASCII paths is NOT to encode the bytes correctly —
    // it's to never bake the path into the file at all.  cmd.exe expands
    // env vars at runtime via the OS native wide-char API, so the actual
    // username encoding doesn't matter.
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
