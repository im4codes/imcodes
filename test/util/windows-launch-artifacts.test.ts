import { describe, expect, it, vi, beforeEach } from 'vitest';

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

describe('writeWatchdogCmd', () => {
  beforeEach(() => {
    for (const k of Object.keys(written)) delete written[k];
  });

  it('generates watchdog with upgrade lock check', async () => {
    const { writeWatchdogCmd, UPGRADE_LOCK_FILE } = await import('../../src/util/windows-launch-artifacts.js');
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

    // Lock file path must be in the check
    const lockPath = UPGRADE_LOCK_FILE.replace(/\//g, '\\');
    expect(cmd).toContain(lockPath);

    // When locked, should wait and loop back (not launch daemon)
    expect(cmd).toContain('Upgrade in progress, waiting');
    expect(cmd).toContain('goto loop');
  });

  it('uses npm global shim instead of hard-coded node+script paths', async () => {
    const { writeWatchdogCmd } = await import('../../src/util/windows-launch-artifacts.js');
    const paths = {
      nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
      imcodesScript: 'C:\\Users\\X\\AppData\\Roaming\\npm\\node_modules\\imcodes\\dist\\src\\index.js',
      watchdogPath: 'C:\\Users\\X\\.imcodes\\daemon-watchdog.cmd',
      vbsPath: 'C:\\Users\\X\\.imcodes\\daemon-launcher.vbs',
      logPath: 'C:\\Users\\X\\.imcodes\\watchdog.log',
    };

    await writeWatchdogCmd(paths);
    const cmd = written[paths.watchdogPath];

    // Should use the shim, not the raw node+script
    expect(cmd).toContain('imcodes.cmd');
    expect(cmd).not.toContain('node_modules');
  });

  it('falls back to node+script when shim not found', async () => {
    // Override existsSync to return false for shim
    const { existsSync } = await import('fs');
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const { writeWatchdogCmd } = await import('../../src/util/windows-launch-artifacts.js');
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
    const { writeWatchdogCmd } = await import('../../src/util/windows-launch-artifacts.js');
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
  beforeEach(() => {
    for (const k of Object.keys(written)) delete written[k];
    for (const k of Object.keys(writtenRaw)) delete writtenRaw[k];
  });

  it('runs watchdog CMD hidden (window style 0)', async () => {
    const { writeVbsLauncher } = await import('../../src/util/windows-launch-artifacts.js');
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
    const { writeVbsLauncher } = await import('../../src/util/windows-launch-artifacts.js');
    const paths = {
      nodeExe: '', imcodesScript: '', logPath: '',
      watchdogPath: 'C:\\Users\\云科I\\.imcodes\\daemon-watchdog.cmd',
      vbsPath: 'C:\\Users\\云科I\\.imcodes\\daemon-launcher.vbs',
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
      expect(decoded).toContain('云科I');
      expect(decoded).toContain('daemon-watchdog.cmd');
    }
  });

  it('uses On Error Resume Next so wscript never pops up an error dialog', async () => {
    const { writeVbsLauncher } = await import('../../src/util/windows-launch-artifacts.js');
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

describe('encodeCmdAsUtf8Bom', () => {
  it('prepends UTF-8 BOM (EF BB BF)', async () => {
    const { encodeCmdAsUtf8Bom } = await import('../../src/util/windows-launch-artifacts.js');
    const buf = encodeCmdAsUtf8Bom('@echo off\r\necho 云科\r\n');
    expect(buf[0]).toBe(0xEF);
    expect(buf[1]).toBe(0xBB);
    expect(buf[2]).toBe(0xBF);
    // Rest is UTF-8 of the content
    const decoded = buf.slice(3).toString('utf8');
    expect(decoded).toContain('云科');
  });
});

describe('encodeVbsAsUtf16', () => {
  it('prepends UTF-16 LE BOM (FF FE)', async () => {
    const { encodeVbsAsUtf16 } = await import('../../src/util/windows-launch-artifacts.js');
    const buf = encodeVbsAsUtf16('WScript.Echo "云科"');
    expect(buf[0]).toBe(0xFF);
    expect(buf[1]).toBe(0xFE);
    const decoded = buf.slice(2).toString('utf16le');
    expect(decoded).toContain('云科');
  });
});

describe('writeWatchdogCmd encoding', () => {
  beforeEach(() => {
    for (const k of Object.keys(written)) delete written[k];
    for (const k of Object.keys(writtenRaw)) delete writtenRaw[k];
  });

  it('writes watchdog .cmd as UTF-8 with BOM (required for non-ASCII paths)', async () => {
    const { writeWatchdogCmd } = await import('../../src/util/windows-launch-artifacts.js');
    const paths = {
      nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
      imcodesScript: 'C:\\Users\\云科I\\AppData\\Roaming\\npm\\node_modules\\imcodes\\dist\\src\\index.js',
      watchdogPath: 'C:\\Users\\云科I\\.imcodes\\daemon-watchdog.cmd',
      vbsPath: 'C:\\Users\\云科I\\.imcodes\\daemon-launcher.vbs',
      logPath: 'C:\\Users\\云科I\\.imcodes\\watchdog.log',
    };

    await writeWatchdogCmd(paths);
    const raw = writtenRaw[paths.watchdogPath];

    expect(Buffer.isBuffer(raw)).toBe(true);
    if (Buffer.isBuffer(raw)) {
      // UTF-8 BOM
      expect(raw[0]).toBe(0xEF);
      expect(raw[1]).toBe(0xBB);
      expect(raw[2]).toBe(0xBF);
      // Path with Chinese characters preserved as UTF-8
      const decoded = raw.slice(3).toString('utf8');
      expect(decoded).toContain('云科I');
    }
  });
});

describe('UPGRADE_LOCK_FILE', () => {
  it('is under .imcodes directory', async () => {
    const { UPGRADE_LOCK_FILE } = await import('../../src/util/windows-launch-artifacts.js');
    expect(UPGRADE_LOCK_FILE).toContain('.imcodes');
    expect(UPGRADE_LOCK_FILE).toContain('upgrade.lock');
  });
});
