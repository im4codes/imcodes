import { AIDESK_HICOLOR_ICONS_BASE64, AIDESK_ICON_SOURCE_SHA256 } from '../../shared/aidesk-icon-generated.js';
import { logoSha256 } from '../../scripts/aidesk-icon.mjs';
import { LOCAL_PANEL_LINUX_WM_CLASS } from '../../shared/local-panel-window.js';
import { mkdtemp, mkdir, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildLinuxAideskDesktopEntry,
  buildWindowsAideskShortcutCommand,
  buildWindowsAideskShortcutRemovalCommand,
  ensureWindowsAideskShortcut,
  ensureLinuxAideskDesktopEntry,
  writeLinuxAideskIcons,
  ensureMacosAideskApplicationEntry,
  isMacosAideskAgentRunning,
  resolveAideskLocalUiExecutable,
  resolveWindowsPowerShellExecutable,
  removeLinuxAideskDesktopEntry,
  removeMacosAideskApplicationEntry,
} from '../../src/node/aidesk-desktop-entry.js';
import {
  AIDESK_LINUX_DESKTOP_FILE_NAME,
  AIDESK_MACOS_APP_NAME,
  AIDESK_PRODUCT_NAME,
} from '../../shared/aidesk-product.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'imcodes-aidesk-entry-'));
  roots.push(value);
  return value;
}

describe('aiDesk desktop entries', () => {
  it('the Linux desktop entry carries the panel window\'s WM_CLASS as StartupWMClass, so the shell shows its name and icon for the browser window', () => {
    const entry = buildLinuxAideskDesktopEntry('/opt/imcodes/imcodes-node');
    expect(entry).toContain(`StartupWMClass=${LOCAL_PANEL_LINUX_WM_CLASS}\n`);
    expect(entry).toContain('Icon=aidesk\n');
  });

  it('resolves the packaged native UI beside the controlled-node executable on each desktop OS', () => {
    expect(resolveAideskLocalUiExecutable('win32', 'D:\\IM.codes\\node.exe')).toBe(
      'D:\\IM.codes\\aidesk-local-ui.exe',
    );
    expect(resolveAideskLocalUiExecutable('linux', '/opt/imcodes/node')).toBe(
      '/opt/imcodes/aidesk-local-ui',
    );
  });

  it('uses the existing signed macOS bundle through an idempotent user Applications link', async () => {
    if (process.platform === 'win32') return;
    const home = await root();
    const source = join(home, 'store', AIDESK_MACOS_APP_NAME);
    await mkdir(source, { recursive: true });
    const input = { home, uid: process.getuid?.() ?? 501, gid: process.getgid?.() ?? 20, signedAppPath: source };
    await expect(ensureMacosAideskApplicationEntry(input)).resolves.toBe('created');
    await expect(readlink(join(home, 'Applications', AIDESK_MACOS_APP_NAME))).resolves.toBe(source);
    await expect(ensureMacosAideskApplicationEntry(input)).resolves.toBe('unchanged');
    await expect(removeMacosAideskApplicationEntry(input)).resolves.toBe(true);
  });

  it('treats a pgrep match as the background aiDesk agent already running', async () => {
    const user = { name: 'ci', uid: 501, gid: 20, home: '/Users/ci', tempDir: '/tmp' };
    const execFileText = async (file: string, args: readonly string[]) => {
      expect(file).toBe('/usr/bin/pgrep');
      expect(args).toEqual(['-u', '501', '-f', expect.stringContaining('aidesk')]);
      return '4242\n';
    };
    await expect(isMacosAideskAgentRunning(user, execFileText)).resolves.toBe(true);
  });

  it('treats pgrep finding nothing (or failing) as the agent not running, fail-safe', async () => {
    const user = { name: 'ci', uid: 501, gid: 20, home: '/Users/ci', tempDir: '/tmp' };
    // pgrep exits non-zero with empty output when nothing matches.
    const notFound = async () => { throw new Error('exit 1'); };
    await expect(isMacosAideskAgentRunning(user, notFound)).resolves.toBe(false);
    const blankOutput = async () => '';
    await expect(isMacosAideskAgentRunning(user, blankOutput)).resolves.toBe(false);
  });

  it('never overwrites or removes a user-created macOS entry with the same name', async () => {
    if (process.platform === 'win32') return;
    const home = await root();
    const source = join(home, 'store', AIDESK_MACOS_APP_NAME);
    const entry = join(home, 'Applications', AIDESK_MACOS_APP_NAME);
    await mkdir(source, { recursive: true });
    await mkdir(entry, { recursive: true });
    const input = { home, uid: process.getuid?.() ?? 501, gid: process.getgid?.() ?? 20, signedAppPath: source };
    await expect(ensureMacosAideskApplicationEntry(input)).resolves.toBe('preserved');
    await expect(removeMacosAideskApplicationEntry(input)).resolves.toBe(false);
  });

  it('quotes Linux paths, repairs only managed entries, updates the cache, and removes reversibly', async () => {
    if (process.platform === 'win32') return;
    const home = await root();
    const calls: string[] = [];
    const input = {
      home,
      uid: process.getuid?.() ?? 501,
      gid: process.getgid?.() ?? 20,
      executablePath: '/opt/ai Desk/$agent',
      runUpdateDatabase: async (directory: string) => { calls.push(directory); },
    };
    await expect(ensureLinuxAideskDesktopEntry(input)).resolves.toBe('created');
    const path = join(home, '.local', 'share', 'applications', AIDESK_LINUX_DESKTOP_FILE_NAME);
    const content = await readFile(path, 'utf8');
    expect(content).toContain(`Name=${AIDESK_PRODUCT_NAME}`);
    expect(content).toContain('Exec="/opt/ai Desk/\\$agent" --open-local-panel');
    await expect(ensureLinuxAideskDesktopEntry(input)).resolves.toBe('unchanged');
    expect(calls).toHaveLength(1);
    // the themed icon the entry names is written (from the bundle, no file next to the executable) as the desktop user's own files
    for (const [size, base64] of Object.entries(AIDESK_HICOLOR_ICONS_BASE64)) {
      const icon = join(home, '.local', 'share', 'icons', 'hicolor', `${size}x${size}`, 'apps', 'aidesk.png');
      expect((await readFile(icon)).equals(Buffer.from(base64, 'base64'))).toBe(true);
      expect((await stat(icon)).mode & 0o777).toBe(0o644);
    }
    await expect(removeLinuxAideskDesktopEntry(home)).resolves.toBe(true);
    for (const size of Object.keys(AIDESK_HICOLOR_ICONS_BASE64)) {
      await expect(stat(join(home, '.local', 'share', 'icons', 'hicolor', `${size}x${size}`, 'apps', 'aidesk.png'))).rejects.toThrow();
    }
  });

  it('never removes or overwrites-away a different aidesk.png of the user on removal, and repairs a damaged one of ours', async () => {
    if (process.platform === 'win32') return;
    const home = await root();
    const ids = { uid: process.getuid?.() ?? 501, gid: process.getgid?.() ?? 20 };
    await ensureLinuxAideskDesktopEntry({ home, ...ids, executablePath: '/x' });
    const size = Object.keys(AIDESK_HICOLOR_ICONS_BASE64)[0]!;
    const icon = join(home, '.local', 'share', 'icons', 'hicolor', `${size}x${size}`, 'apps', 'aidesk.png');
    await writeFile(icon, 'the user\'s own picture');
    await removeLinuxAideskDesktopEntry(home);
    expect(await readFile(icon, 'utf8')).toBe('the user\'s own picture');
    await expect(writeLinuxAideskIcons(home, ids.uid, ids.gid)).resolves.toBe(true); // a changed file is rewritten with ours
    expect((await readFile(icon)).equals(Buffer.from(AIDESK_HICOLOR_ICONS_BASE64[Number(size)]!, 'base64'))).toBe(true);
    await expect(writeLinuxAideskIcons(home, ids.uid, ids.gid)).resolves.toBe(false); // nothing to do the second time
  });

  it('the embedded icons are the official logo\'s: hash recorded, PNG signature, small enough to ship inside the bundle', () => {
    expect(AIDESK_ICON_SOURCE_SHA256).toBe(logoSha256());
    const total = Object.values(AIDESK_HICOLOR_ICONS_BASE64).reduce((sum, base64) => sum + base64.length, 0);
    expect(total).toBeLessThan(60_000);
    for (const base64 of Object.values(AIDESK_HICOLOR_ICONS_BASE64)) {
      expect(Buffer.from(base64, 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    }
    expect(Object.keys(AIDESK_HICOLOR_ICONS_BASE64).map(Number)).toEqual(expect.arrayContaining([48, 256]));
  });

  it('preserves an unmanaged Linux entry and rejects control characters in paths', async () => {
    if (process.platform === 'win32') return;
    const home = await root();
    const directory = join(home, '.local', 'share', 'applications');
    await mkdir(directory, { recursive: true });
    const path = join(directory, AIDESK_LINUX_DESKTOP_FILE_NAME);
    await writeFile(path, '[Desktop Entry]\nName=mine\n');
    const input = { home, uid: process.getuid?.() ?? 501, gid: process.getgid?.() ?? 20, executablePath: '/x' };
    await expect(ensureLinuxAideskDesktopEntry(input)).resolves.toBe('preserved');
    await expect(removeLinuxAideskDesktopEntry(home)).resolves.toBe(false);
    expect(() => buildLinuxAideskDesktopEntry('/bad\npath')).toThrow();
  });

  it('encodes Windows paths as data and repairs only an owned shortcut', () => {
    const command = buildWindowsAideskShortcutCommand(
      'C:\\Program Files\\IM.codes\\node.exe',
      'C:\\ProgramData\\IM.codes\\entry.result',
    );
    const encoded = command.split(' ').at(-1)!;
    const script = Buffer.from(encoded, 'base64').toString('utf16le');
    expect(script).toContain("GetFolderPath('Programs')");
    expect(script).toContain("$old.Description -ne $description");
    expect(script).toContain("Report 'preserved'");
    expect(script).toContain("Report 'unchanged'");
    expect(script).toContain("$status='repaired'");
    expect(script).toContain('Report $status');
    expect(script).toContain("$shortcut.Arguments='--open-local-panel'");
    expect(script).not.toContain('C:\\Program Files\\IM.codes\\node.exe');
    const remove = Buffer.from(
      buildWindowsAideskShortcutRemovalCommand().split(' ').at(-1)!, 'base64',
    ).toString('utf16le');
    expect(remove).toContain('if($old.Description -eq $description)');
    expect(remove).toContain('Remove-Item -LiteralPath $path -Force');
  });

  it('waits for the active-user shortcut result instead of claiming fire-and-forget success', async () => {
    const directory = await root();
    for (const result of ['created', 'repaired', 'unchanged', 'preserved'] as const) {
      const seen: string[] = [];
      await expect(ensureWindowsAideskShortcut({
        executablePath: 'C:\\Program Files\\IM.codes\\node.exe',
        resultRoot: directory,
        grantResultAccess: async () => {},
        pollMs: 1,
        timeoutMs: 100,
        launch: async (command) => {
          const encoded = command.split(' ').at(-1)!;
          const script = Buffer.from(encoded, 'base64').toString('utf16le');
          const result64 = /\$resultPath=\$utf8\.GetString\(\[Convert\]::FromBase64String\('([^']+)'\)\)/u
            .exec(script)?.[1];
          const resultPath = Buffer.from(result64!, 'base64').toString('utf8');
          seen.push(script);
          await writeFile(resultPath, result);
        },
      })).resolves.toBe(result);
      expect(seen).toHaveLength(1);
    }
    await expect(ensureWindowsAideskShortcut({
      executablePath: 'C:\\node.exe', resultRoot: directory,
      grantResultAccess: async () => {}, timeoutMs: 10, pollMs: 1,
      launch: (_command, onFailure) => onFailure('denied'),
    })).resolves.toBe('failed');
  });

  it('launches shortcut PowerShell through an absolute SystemRoot executable', async () => {
    const directory = await root();
    const executables: string[] = [];
    await expect(ensureWindowsAideskShortcut({
      executablePath: 'D:\\Program Files\\IM.codes\\node.exe',
      resultRoot: directory,
      grantResultAccess: async () => {},
      windowsEnvironment: { SystemRoot: 'D:\\Windows' },
      launchActiveUserProcess: async (executable, command) => {
        executables.push(executable);
        const encoded = command.split(' ').at(-1)!;
        const script = Buffer.from(encoded, 'base64').toString('utf16le');
        const result64 = /\$resultPath=\$utf8\.GetString\(\[Convert\]::FromBase64String\('([^']+)'\)\)/u
          .exec(script)?.[1];
        await writeFile(Buffer.from(result64!, 'base64').toString('utf8'), 'created');
      },
      pollMs: 1,
      timeoutMs: 100,
    })).resolves.toBe('created');
    expect(executables).toEqual([
      'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ]);
    expect(resolveWindowsPowerShellExecutable({ WINDIR: 'E:\\Win' })).toBe(
      'E:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
  });

  it('fails explicitly instead of falling back to a relative PowerShell executable', async () => {
    const directory = await root();
    let launched = false;
    await expect(ensureWindowsAideskShortcut({
      executablePath: 'C:\\node.exe',
      resultRoot: directory,
      grantResultAccess: async () => {},
      windowsEnvironment: {},
      launchActiveUserProcess: () => { launched = true; },
      pollMs: 1,
      timeoutMs: 10,
    })).resolves.toBe('failed');
    expect(launched).toBe(false);
    expect(() => resolveWindowsPowerShellExecutable({})).toThrow(
      'aidesk_windows_system_root_unavailable',
    );
  });
});
