import { mkdtemp, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildLinuxAideskDesktopEntry,
  buildWindowsAideskShortcutCommand,
  buildWindowsAideskShortcutRemovalCommand,
  ensureWindowsAideskShortcut,
  ensureLinuxAideskDesktopEntry,
  ensureMacosAideskApplicationEntry,
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
      iconPath: '/opt/ai Desk/icon.png',
      runUpdateDatabase: async (directory: string) => { calls.push(directory); },
    };
    await expect(ensureLinuxAideskDesktopEntry(input)).resolves.toBe('created');
    const path = join(home, '.local', 'share', 'applications', AIDESK_LINUX_DESKTOP_FILE_NAME);
    const content = await readFile(path, 'utf8');
    expect(content).toContain(`Name=${AIDESK_PRODUCT_NAME}`);
    expect(content).toContain('Exec="/opt/ai Desk/\\$agent" --open-local-panel');
    await expect(ensureLinuxAideskDesktopEntry(input)).resolves.toBe('unchanged');
    expect(calls).toHaveLength(1);
    await expect(removeLinuxAideskDesktopEntry(home)).resolves.toBe(true);
  });

  it('preserves an unmanaged Linux entry and rejects control characters in paths', async () => {
    if (process.platform === 'win32') return;
    const home = await root();
    const directory = join(home, '.local', 'share', 'applications');
    await mkdir(directory, { recursive: true });
    const path = join(directory, AIDESK_LINUX_DESKTOP_FILE_NAME);
    await writeFile(path, '[Desktop Entry]\nName=mine\n');
    const input = { home, uid: process.getuid?.() ?? 501, gid: process.getgid?.() ?? 20, executablePath: '/x', iconPath: '/i' };
    await expect(ensureLinuxAideskDesktopEntry(input)).resolves.toBe('preserved');
    await expect(removeLinuxAideskDesktopEntry(home)).resolves.toBe(false);
    expect(() => buildLinuxAideskDesktopEntry('/bad\npath', '/icon')).toThrow();
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
        launch: (command) => {
          const encoded = command.split(' ').at(-1)!;
          const script = Buffer.from(encoded, 'base64').toString('utf16le');
          const result64 = /\$resultPath=\$utf8\.GetString\(\[Convert\]::FromBase64String\('([^']+)'\)\)/u
            .exec(script)?.[1];
          const resultPath = Buffer.from(result64!, 'base64').toString('utf8');
          seen.push(script);
          void writeFile(resultPath, result);
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
      launchActiveUserProcess: (executable, command) => {
        executables.push(executable);
        const encoded = command.split(' ').at(-1)!;
        const script = Buffer.from(encoded, 'base64').toString('utf16le');
        const result64 = /\$resultPath=\$utf8\.GetString\(\[Convert\]::FromBase64String\('([^']+)'\)\)/u
          .exec(script)?.[1];
        void writeFile(Buffer.from(result64!, 'base64').toString('utf8'), 'created');
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
