import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
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
import { basename, dirname, join } from 'node:path';
import {
  controlledNodeComputerUseHelperFilename,
  CONTROLLED_NODE_OS_MAC,
} from '../../shared/controlled-node-artifacts.js';
import type { MacosUserSession } from './user-session-launcher.js';

export const MACOS_COMPUTER_USE_RUNTIME_ROOT = '/Library/Application Support/imcodes-node-computer-use';
export const MACOS_COMPUTER_USE_APP_NAME = 'Open Computer Use.app';
export const MACOS_AIDESK_APP_NAME = 'aiDesk.to by IM.codes.app';

const MACOS_COMPUTER_USE_EXECUTABLE = 'OpenComputerUse';
const MACOS_AIDESK_EXECUTABLE = 'aidesk-agent';
const MACOS_COMPUTER_USE_BUNDLE_ID = 'com.ifuryst.opencomputeruse';
const MACOS_COMPUTER_USE_TEAM_ID = 'J9P29FA5BX';
const MACOS_AIDESK_BUNDLE_ID = 'to.aidesk.app';
const MACOS_AIDESK_TEAM_ID = 'M675E26Q67';
const MACOS_COMPUTER_USE_SOURCE_DIGEST = '.open-computer-use-source.sha256';

export type MacosConsoleUser = MacosUserSession;

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
  const legacy = details.includes(`Identifier=${MACOS_COMPUTER_USE_BUNDLE_ID}`)
    && details.includes(`TeamIdentifier=${MACOS_COMPUTER_USE_TEAM_ID}`);
  const aiDesk = details.includes(`Identifier=${MACOS_AIDESK_BUNDLE_ID}`)
    && details.includes(`TeamIdentifier=${MACOS_AIDESK_TEAM_ID}`);
  if ((!legacy && !aiDesk) || !details.includes('Authority=Developer ID Application:')) {
    throw new Error('computer_use_app_untrusted_signature');
  }
}

export function validateMacosComputerUseArchiveEntries(entries: readonly string[]): void {
  if (entries.length === 0) throw new Error('computer_use_app_archive_empty');
  const roots = new Set<string>();
  for (const rawEntry of entries) {
    const entry = rawEntry.endsWith('/') ? rawEntry.slice(0, -1) : rawEntry;
    const components = entry.split('/');
    if (!entry
      || entry.startsWith('/')
      || entry.includes('\\')
      || (components[0] !== MACOS_COMPUTER_USE_APP_NAME
        && components[0] !== MACOS_AIDESK_APP_NAME)
      || components.some((component) => component === '' || component === '.' || component === '..')) {
      throw new Error('computer_use_app_archive_unsafe');
    }
    roots.add(components[0]);
  }
  if (roots.size !== 1) throw new Error('computer_use_app_archive_unsafe');
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

async function publishFile(source: string, destination: string, mode: number): Promise<void> {
  if (!await isRegularFile(source)) throw new Error('computer_use_runtime_source_not_regular');
  if (source === destination) return;
  const existing = await isRegularFile(destination);
  if (existing && await sha256File(source) === await sha256File(destination)) return;
  const temp = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await copyFile(source, temp);
  await chmod(temp, mode);
  await rename(temp, destination);
}

async function readSourceDigest(path: string): Promise<string | null> {
  if (!await isRegularFile(path)) return null;
  const value = (await readFile(path, 'utf8')).trim();
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}

async function publishAppBundle(
  sourceArchive: string,
  runtimeRoot: string,
  options: Required<Pick<MacosComputerUseRuntimeOptions, 'verifyAppBundle' | 'extractAppArchive'>>,
): Promise<string> {
  if (!await isRegularFile(sourceArchive)) throw new Error('computer_use_helper_not_installed');
  const sourceDigest = await sha256File(sourceArchive);
  const digestPath = join(runtimeRoot, MACOS_COMPUTER_USE_SOURCE_DIGEST);
  if (await readSourceDigest(digestPath) === sourceDigest) {
    for (const [name, executable] of [
      [MACOS_AIDESK_APP_NAME, MACOS_AIDESK_EXECUTABLE],
      [MACOS_COMPUTER_USE_APP_NAME, MACOS_COMPUTER_USE_EXECUTABLE],
    ] as const) {
      const existing = join(runtimeRoot, name);
      if (!await isRegularFile(join(existing, 'Contents', 'MacOS', executable))) continue;
      try {
        await options.verifyAppBundle(existing);
        return existing;
      } catch {
        // A matching archive digest never authorizes an invalid or replaced app.
      }
    }
  }

  const extractionRoot = join(runtimeRoot, `.open-computer-use-extract-${process.pid}-${randomUUID()}`);
  let appPath = '';
  let extractedApp = '';
  let backupApp = '';
  await rm(extractionRoot, { recursive: true, force: true });
  await mkdir(extractionRoot, { recursive: true, mode: 0o755 });
  try {
    await options.extractAppArchive(sourceArchive, extractionRoot);
    const extractedNames: string[] = [];
    for (const name of [MACOS_AIDESK_APP_NAME, MACOS_COMPUTER_USE_APP_NAME]) {
      if (await lstat(join(extractionRoot, name)).then(() => true, () => false)) extractedNames.push(name);
    }
    if (extractedNames.length !== 1) throw new Error('computer_use_app_archive_unsafe');
    const appName = extractedNames[0]!;
    extractedApp = join(extractionRoot, appName);
    appPath = join(runtimeRoot, appName);
    backupApp = `${appPath}.${process.pid}.${randomUUID()}.old`;
    await validateExtractedAppTree(extractedApp);
    const executable = appName === MACOS_AIDESK_APP_NAME
      ? MACOS_AIDESK_EXECUTABLE
      : MACOS_COMPUTER_USE_EXECUTABLE;
    if (!await isRegularFile(join(extractedApp, 'Contents', 'MacOS', executable))) {
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
      if (appName === MACOS_AIDESK_APP_NAME) {
        await rm(join(runtimeRoot, MACOS_COMPUTER_USE_APP_NAME), { recursive: true, force: true });
      }
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
  return appPath;
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
  let appPath = join(runtimeRoot, MACOS_AIDESK_APP_NAME);

  await mkdir(runtimeRoot, { recursive: true, mode: 0o755 });
  const runtimeStat = await lstat(runtimeRoot);
  if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) {
    throw new Error('computer_use_runtime_root_not_directory');
  }
  await chmod(runtimeRoot, 0o755);
  await publishFile(sourceNodeExecutable, helperExecutable, 0o755);
  await verifyCodeSignature(helperExecutable, false);

  if (sourceOpenComputerUseArchive) {
    appPath = await publishAppBundle(sourceOpenComputerUseArchive, runtimeRoot, { verifyAppBundle, extractAppArchive });
    await publishFile(
      sourceOpenComputerUseArchive,
      join(runtimeRoot, controlledNodeComputerUseHelperFilename(CONTROLLED_NODE_OS_MAC)),
      0o644,
    );
  } else {
    const candidates = [
      join(runtimeRoot, MACOS_AIDESK_APP_NAME),
      join(runtimeRoot, MACOS_COMPUTER_USE_APP_NAME),
    ];
    const existing = candidates.find((candidate) => {
      const executable = basename(candidate) === MACOS_AIDESK_APP_NAME
        ? MACOS_AIDESK_EXECUTABLE : MACOS_COMPUTER_USE_EXECUTABLE;
      return existsSync(join(candidate, 'Contents', 'MacOS', executable));
    });
    if (!existing) throw new Error('computer_use_helper_not_installed');
    appPath = existing;
    await verifyAppBundle(existing);
  }

  const openComputerUseExecutable = join(
    appPath,
    'Contents',
    'MacOS',
    basename(appPath) === MACOS_AIDESK_APP_NAME
      ? MACOS_AIDESK_EXECUTABLE
      : MACOS_COMPUTER_USE_EXECUTABLE,
  );
  return { helperExecutable, openComputerUseExecutable };
}

export async function authorizeMacosComputerUseSocket(path: string, user: MacosConsoleUser): Promise<void> {
  await chown(path, user.uid, user.gid);
  await chmod(path, 0o600);
}
