import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── Mock fs so writeWatchdogCmd doesn't touch disk ─────────────────────────

const written: Record<string, string> = {};

vi.mock('fs/promises', () => ({
  writeFile: vi.fn(async (path: string, content: string) => { written[path] = content; }),
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
});

describe('UPGRADE_LOCK_FILE', () => {
  it('is under .imcodes directory', async () => {
    const { UPGRADE_LOCK_FILE } = await import('../../src/util/windows-launch-artifacts.js');
    expect(UPGRADE_LOCK_FILE).toContain('.imcodes');
    expect(UPGRADE_LOCK_FILE).toContain('upgrade.lock');
  });
});
