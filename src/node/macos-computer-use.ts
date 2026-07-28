import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  chown,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const MACOS_COMPUTER_USE_RUNTIME_ROOT = '/Library/Application Support/imcodes-node-computer-use';
export const MACOS_COMPUTER_USE_APP_NAME = 'Open Computer Use.app';

const MACOS_COMPUTER_USE_EXECUTABLE = 'OpenComputerUse';
const MACOS_COMPUTER_USE_BUNDLE_ID = 'com.ifuryst.opencomputeruse';
const MACOS_COMPUTER_USE_TEAM_ID = 'J9P29FA5BX';
const MACOS_COMPUTER_USE_SOURCE_DIGEST = '.open-computer-use-source.sha256';

export interface MacosConsoleUser {
  name: string;
  uid: number;
  gid: number;
  home: string;
  tempDir: string;
}

export interface MacosComputerUseRuntime {
  helperExecutable: string;
  openComputerUseExecutable: string;
}

interface MacosComputerUseRuntimeOptions {
  runtimeRoot?: string;
  verifyCodeSignature?: (path: string, deep: boolean) => Promise<void>;
  verifyAppBundle?: (path: string) => Promise<void>;
  extractAppArchive?: (archivePath: string, destinationRoot: string) => Promise<void>;
}

function execFileText(file: string, args: readonly string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { encoding: 'utf8', timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message).trim()));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function defaultVerifyCodeSignature(path: string, deep: boolean): Promise<void> {
  await execFileText('/usr/bin/codesign', [
    '--verify',
    ...(deep ? ['--deep'] : []),
    '--strict',
    path,
  ]);
}

async function defaultVerifyAppBundle(path: string): Promise<void> {
  await defaultVerifyCodeSignature(path, true);
  const details = await new Promise<string>((resolve, reject) => {
    execFile('/usr/bin/codesign', ['-dv', '--verbose=4', path], { encoding: 'utf8', timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message).trim()));
        return;
      }
      resolve(`${stdout}\n${stderr}`);
    });
  });
  if (!details.includes(`Identifier=${MACOS_COMPUTER_USE_BUNDLE_ID}`)
    || !details.includes(`TeamIdentifier=${MACOS_COMPUTER_USE_TEAM_ID}`)
    || !details.includes('Authority=Developer ID Application:')) {
    throw new Error('computer_use_app_untrusted_signature');
  }
}

export function validateMacosComputerUseArchiveEntries(entries: readonly string[]): void {
  if (entries.length === 0) throw new Error('computer_use_app_archive_empty');
  for (const rawEntry of entries) {
    const entry = rawEntry.endsWith('/') ? rawEntry.slice(0, -1) : rawEntry;
    const components = entry.split('/');
    if (!entry
      || entry.startsWith('/')
      || entry.includes('\\')
      || components[0] !== MACOS_COMPUTER_USE_APP_NAME
      || components.some((component) => component === '' || component === '.' || component === '..')) {
      throw new Error('computer_use_app_archive_unsafe');
    }
  }
}

async function validateExtractedAppTree(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    throw new Error('computer_use_app_archive_unsafe');
  }
  if (!stat.isDirectory()) return;
  for (const name of await readdir(path)) {
    await validateExtractedAppTree(join(path, name));
  }
}

async function defaultExtractAppArchive(archivePath: string, destinationRoot: string): Promise<void> {
  const entries = (await execFileText('/usr/bin/unzip', ['-Z1', archivePath]))
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
  validateMacosComputerUseArchiveEntries(entries);
  await execFileText('/usr/bin/ditto', ['-x', '-k', archivePath, destinationRoot]);
}

async function publishExecutable(source: string, destination: string): Promise<void> {
  if (!await isRegularFile(source)) throw new Error('computer_use_runtime_source_not_regular');
  const existing = await isRegularFile(destination);
  if (existing && await sha256File(source) === await sha256File(destination)) return;
  const temp = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await copyFile(source, temp);
  await chmod(temp, 0o755);
  await rename(temp, destination);
}

async function readSourceDigest(path: string): Promise<string | null> {
  if (!await isRegularFile(path)) return null;
  const value = (await readFile(path, 'utf8')).trim();
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}

async function publishAppBundle(
  sourceArchive: string,
  appPath: string,
  options: Required<Pick<MacosComputerUseRuntimeOptions, 'verifyAppBundle' | 'extractAppArchive'>>,
): Promise<void> {
  if (!await isRegularFile(sourceArchive)) throw new Error('computer_use_helper_not_installed');
  const sourceDigest = await sha256File(sourceArchive);
  const digestPath = join(dirname(appPath), MACOS_COMPUTER_USE_SOURCE_DIGEST);
  const appExecutable = join(appPath, 'Contents', 'MacOS', MACOS_COMPUTER_USE_EXECUTABLE);
  if (await readSourceDigest(digestPath) === sourceDigest && await isRegularFile(appExecutable)) {
    try {
      await options.verifyAppBundle(appPath);
      return;
    } catch {
      // A matching archive digest never authorizes an invalid or replaced app.
    }
  }

  const extractionRoot = join(dirname(appPath), `.open-computer-use-extract-${process.pid}-${randomUUID()}`);
  const extractedApp = join(extractionRoot, MACOS_COMPUTER_USE_APP_NAME);
  const backupApp = `${appPath}.${process.pid}.${randomUUID()}.old`;
  await rm(extractionRoot, { recursive: true, force: true });
  await mkdir(extractionRoot, { recursive: true, mode: 0o755 });
  try {
    await options.extractAppArchive(sourceArchive, extractionRoot);
    await validateExtractedAppTree(extractedApp);
    if (!await isRegularFile(join(extractedApp, 'Contents', 'MacOS', MACOS_COMPUTER_USE_EXECUTABLE))) {
      throw new Error('computer_use_helper_not_installed');
    }
    await options.verifyAppBundle(extractedApp);

    let movedExisting = false;
    let publishedNew = false;
    try {
      await rm(digestPath, { force: true });
      if (await lstat(appPath).then(() => true, () => false)) {
        await rename(appPath, backupApp);
        movedExisting = true;
      }
      await rename(extractedApp, appPath);
      publishedNew = true;
      await options.verifyAppBundle(appPath);
      await rm(backupApp, { recursive: true, force: true });
    } catch (error) {
      if (publishedNew) await rm(appPath, { recursive: true, force: true }).catch(() => {});
      if (movedExisting) await rename(backupApp, appPath).catch(() => {});
      throw error;
    }
    const tempDigest = `${digestPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempDigest, `${sourceDigest}\n`, { mode: 0o644 });
      await rename(tempDigest, digestPath);
    } finally {
      await rm(tempDigest, { force: true }).catch(() => {});
    }
  } finally {
    await rm(extractionRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export async function prepareMacosComputerUseRuntime(
  sourceNodeExecutable: string,
  sourceOpenComputerUseArchive: string | undefined,
  options: MacosComputerUseRuntimeOptions = {},
): Promise<MacosComputerUseRuntime> {
  const runtimeRoot = options.runtimeRoot ?? MACOS_COMPUTER_USE_RUNTIME_ROOT;
  const verifyCodeSignature = options.verifyCodeSignature ?? defaultVerifyCodeSignature;
  const verifyAppBundle = options.verifyAppBundle ?? defaultVerifyAppBundle;
  const extractAppArchive = options.extractAppArchive ?? defaultExtractAppArchive;
  const helperExecutable = join(runtimeRoot, 'imcodes-computer-use-helper');
  const appPath = join(runtimeRoot, MACOS_COMPUTER_USE_APP_NAME);
  const openComputerUseExecutable = join(appPath, 'Contents', 'MacOS', MACOS_COMPUTER_USE_EXECUTABLE);

  await mkdir(runtimeRoot, { recursive: true, mode: 0o755 });
  const runtimeStat = await lstat(runtimeRoot);
  if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) {
    throw new Error('computer_use_runtime_root_not_directory');
  }
  await chmod(runtimeRoot, 0o755);
  await publishExecutable(sourceNodeExecutable, helperExecutable);
  await verifyCodeSignature(helperExecutable, false);

  if (sourceOpenComputerUseArchive) {
    await publishAppBundle(sourceOpenComputerUseArchive, appPath, { verifyAppBundle, extractAppArchive });
  } else if (!await isRegularFile(openComputerUseExecutable)) {
    throw new Error('computer_use_helper_not_installed');
  } else {
    await verifyAppBundle(appPath);
  }

  return { helperExecutable, openComputerUseExecutable };
}

function validMacosUserName(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value)
    && value !== 'root'
    && value !== 'loginwindow'
    && value !== '_mbsetupuser';
}

function positiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function resolveMacosConsoleUser(): Promise<MacosConsoleUser> {
  const name = await execFileText('/usr/bin/stat', ['-f', '%Su', '/dev/console']);
  if (!validMacosUserName(name)) throw new Error('computer_use_no_active_gui_session');
  const uid = positiveInteger(await execFileText('/usr/bin/id', ['-u', name]));
  const gid = positiveInteger(await execFileText('/usr/bin/id', ['-g', name]));
  if (uid === null || gid === null) throw new Error('computer_use_invalid_console_user');
  const home = await execFileText('/usr/bin/dscl', ['.', '-read', `/Users/${name}`, 'NFSHomeDirectory'])
    .then((line) => line.replace(/^NFSHomeDirectory:\s*/, '').trim());
  if (!home.startsWith('/') || home.includes('\n')) throw new Error('computer_use_invalid_console_user_home');
  const tempDir = await execFileText('/usr/bin/sudo', [
    '-n',
    '-u',
    name,
    '/usr/bin/getconf',
    'DARWIN_USER_TEMP_DIR',
  ]);
  if (!tempDir.startsWith('/') || tempDir.includes('\n')) throw new Error('computer_use_invalid_console_user_temp');
  return { name, uid, gid, home, tempDir };
}

export async function authorizeMacosComputerUseSocket(path: string, user: MacosConsoleUser): Promise<void> {
  await chown(path, user.uid, user.gid);
  await chmod(path, 0o600);
}

export function macosUserSessionHelperArgs(
  user: MacosConsoleUser,
  runtime: MacosComputerUseRuntime,
  pipe: string,
): string[] {
  return [
    ...macosUserSessionCommandPrefix(user),
    `IMCODES_COMPUTER_USE_EXE=${runtime.openComputerUseExecutable}`,
    runtime.helperExecutable,
    '--computer-use-helper',
    '--pipe',
    pipe,
  ];
}

function macosUserSessionCommandPrefix(user: MacosConsoleUser): string[] {
  return [
    'asuser',
    String(user.uid),
    '/usr/bin/sudo',
    '-n',
    '-u',
    user.name,
    '/usr/bin/env',
    `HOME=${user.home}`,
    `TMPDIR=${user.tempDir}`,
  ];
}

export function macosComputerUseDoctorArgs(
  user: MacosConsoleUser,
  runtime: MacosComputerUseRuntime,
): string[] {
  return [
    ...macosUserSessionCommandPrefix(user),
    runtime.openComputerUseExecutable,
    'doctor',
  ];
}

export async function runMacosComputerUseDoctor(
  user: MacosConsoleUser,
  runtime: MacosComputerUseRuntime,
): Promise<void> {
  await execFileText('/bin/launchctl', macosComputerUseDoctorArgs(user, runtime), 10_000);
}

export function launchMacosUserSessionHelper(
  user: MacosConsoleUser,
  runtime: MacosComputerUseRuntime,
  pipe: string,
): ChildProcess {
  const child = spawn('/bin/launchctl', macosUserSessionHelperArgs(user, runtime, pipe), {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}
