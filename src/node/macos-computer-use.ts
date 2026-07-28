import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  chown,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

export const MACOS_COMPUTER_USE_RUNTIME_ROOT = '/Library/Application Support/imcodes-node-computer-use';
export const MACOS_COMPUTER_USE_APP_NAME = 'Open Computer Use.app';

const MACOS_COMPUTER_USE_EXECUTABLE = 'OpenComputerUse';
const MACOS_COMPUTER_USE_BUNDLE_ID = 'com.ifuryst.opencomputeruse';

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
  signAppBundle?: (path: string) => Promise<void>;
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

async function defaultSignAppBundle(path: string): Promise<void> {
  await execFileText('/usr/bin/codesign', ['--force', '--sign', '-', '--deep', path]);
}

export function macosComputerUseInfoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>${MACOS_COMPUTER_USE_EXECUTABLE}</string>
  <key>CFBundleIdentifier</key><string>${MACOS_COMPUTER_USE_BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Open Computer Use</string>
  <key>CFBundleDisplayName</key><string>Open Computer Use</string>
  <key>OpenComputerUseAppVariant</key><string>release</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.2.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
`;
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

async function appBundleMatchesSource(appExecutable: string, source: string): Promise<boolean> {
  if (!await isRegularFile(appExecutable)) return false;
  return await sha256File(appExecutable) === await sha256File(source);
}

async function publishAppBundle(
  sourceExecutable: string,
  appPath: string,
  options: Required<Pick<MacosComputerUseRuntimeOptions, 'verifyCodeSignature' | 'signAppBundle'>>,
): Promise<void> {
  const appExecutable = join(appPath, 'Contents', 'MacOS', MACOS_COMPUTER_USE_EXECUTABLE);
  if (await appBundleMatchesSource(appExecutable, sourceExecutable)) {
    await options.verifyCodeSignature(appPath, true);
    return;
  }

  const tempApp = `${appPath}.${process.pid}.${randomUUID()}.tmp`;
  const backupApp = `${appPath}.${process.pid}.${randomUUID()}.old`;
  await rm(tempApp, { recursive: true, force: true });
  await mkdir(join(tempApp, 'Contents', 'MacOS'), { recursive: true, mode: 0o755 });
  await writeFile(join(tempApp, 'Contents', 'Info.plist'), macosComputerUseInfoPlist(), { mode: 0o644 });
  await copyFile(sourceExecutable, join(tempApp, 'Contents', 'MacOS', MACOS_COMPUTER_USE_EXECUTABLE));
  await chmod(join(tempApp, 'Contents', 'MacOS', MACOS_COMPUTER_USE_EXECUTABLE), 0o755);
  await options.signAppBundle(tempApp);
  await options.verifyCodeSignature(tempApp, true);

  let movedExisting = false;
  try {
    if (await lstat(appPath).then(() => true, () => false)) {
      await rename(appPath, backupApp);
      movedExisting = true;
    }
    await rename(tempApp, appPath);
    await rm(backupApp, { recursive: true, force: true });
  } catch (error) {
    if (movedExisting) await rename(backupApp, appPath).catch(() => {});
    throw error;
  } finally {
    await rm(tempApp, { recursive: true, force: true }).catch(() => {});
  }
}

export async function prepareMacosComputerUseRuntime(
  sourceNodeExecutable: string,
  sourceOpenComputerUseExecutable: string | undefined,
  options: MacosComputerUseRuntimeOptions = {},
): Promise<MacosComputerUseRuntime> {
  const runtimeRoot = options.runtimeRoot ?? MACOS_COMPUTER_USE_RUNTIME_ROOT;
  const verifyCodeSignature = options.verifyCodeSignature ?? defaultVerifyCodeSignature;
  const signAppBundle = options.signAppBundle ?? defaultSignAppBundle;
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

  if (sourceOpenComputerUseExecutable) {
    if (!await isRegularFile(sourceOpenComputerUseExecutable)) throw new Error('computer_use_helper_not_installed');
    await publishAppBundle(sourceOpenComputerUseExecutable, appPath, { verifyCodeSignature, signAppBundle });
  } else if (!await isRegularFile(openComputerUseExecutable)) {
    throw new Error('computer_use_helper_not_installed');
  } else {
    await verifyCodeSignature(appPath, true);
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
