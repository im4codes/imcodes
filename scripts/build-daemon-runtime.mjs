#!/usr/bin/env node
/**
 * Build and verify the standalone, relocatable, read-only Coding Daemon runtime
 * bundle (`daemon-runtime/<os>-<arch>`).
 *
 * Reuses official Node download + SHASUMS256 verification and platform signing
 * tooling without cramming daemon native addons into `imcodes-node` or inside
 * `aiDesk.to by IM.codes.app`.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  readSync,
  closeSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DAEMON_RUNTIME_FILES_FILENAME,
  DEFAULT_DAEMON_RUNTIME_NODE_VERSION,
  createArchiveFromDir,
  createDaemonRuntimeFilesDocument,
  createDaemonRuntimeManifest,
  extractArchiveToDir,
  parseDaemonRuntimeTarget,
  pruneStagedNodeModulesForTarget,
  removeDirForceSync,
  resolvePlatformCommand,
  shouldKeepPackageLockEntry,
  verifyDaemonRuntimeArchive,
  writeDaemonRuntimeJson,
} from './daemon-runtime-artifacts.mjs';
import {
  normalizeNodeExeBuildVersion,
  sha256File,
  verifyOfficialNodeArtifact,
} from './node-exe-artifacts.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const OFFICIAL_NODE_DIST = 'https://nodejs.org/dist';
const NODE_MIRROR = (process.env.NODE_EXE_MIRROR ?? OFFICIAL_NODE_DIST).replace(/\/+$/, '');

export function sh(file, args, opts = {}) {
  const { platform, env, execFileSyncImpl, ...spawnOpts } = opts;
  const resolved = resolvePlatformCommand(file, args, { platform, env });
  const run = execFileSyncImpl ?? execFileSync;
  return run(resolved.command, resolved.args, {
    stdio: 'inherit',
    ...(env !== undefined ? { env } : {}),
    ...spawnOpts,
    ...resolved.options,
  });
}

function parseArgs(argv) {
  const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const opts = {
    os: process.platform,
    arch: hostArch,
    outDir: join(repoRoot, 'dist-node-exe', 'daemon-runtime'),
    nodeVersion: process.env.DAEMON_RUNTIME_NODE_VERSION?.trim()
      || process.env.NODE_EXE_NODE_VERSION?.trim()
      || DEFAULT_DAEMON_RUNTIME_NODE_VERSION,
    nodeBin: process.env.DAEMON_RUNTIME_NODE_BIN?.trim() || '',
    sourceNodeModules: join(repoRoot, 'node_modules'),
    explicitSourceNodeModules: false,
    buildVersion: '',
    skipBuild: false,
    keepStaging: false,
    stageDir: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--target') {
      const parsed = parseDaemonRuntimeTarget(argv[++i]);
      opts.os = parsed.os;
      opts.arch = parsed.arch;
    } else if (arg === '--os') {
      opts.os = argv[++i];
    } else if (arg === '--arch') {
      opts.arch = argv[++i];
    } else if (arg === '--out-dir') {
      opts.outDir = resolve(argv[++i]);
    } else if (arg === '--stage-dir') {
      opts.stageDir = resolve(argv[++i]);
      opts.keepStaging = true;
    } else if (arg === '--node-version') {
      opts.nodeVersion = argv[++i];
    } else if (arg === '--node-bin') {
      opts.nodeBin = resolve(argv[++i]);
    } else if (arg === '--source-node-modules') {
      opts.sourceNodeModules = resolve(argv[++i]);
      opts.explicitSourceNodeModules = true;
    } else if (arg === '--build-version') {
      opts.buildVersion = argv[++i];
    } else if (arg === '--skip-build') {
      opts.skipBuild = true;
    } else if (arg === '--keep-staging') {
      opts.keepStaging = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: build-daemon-runtime.mjs [--target <os>-<arch>] [--os <os> --arch <arch>] '
        + '[--out-dir <dir>] [--node-version <v24.x.y>] [--node-bin <path>] '
        + '[--source-node-modules <dir>] [--build-version <ver>] [--skip-build] [--keep-staging]',
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return { ...opts, targetInfo: parseDaemonRuntimeTarget(opts.os, opts.arch) };
}

async function downloadFile(url, destination, redirect = 'follow') {
  const response = await fetch(url, { redirect });
  if (!response.ok) throw new Error(`download failed (${response.status}) for ${url}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

async function resolveNodeBinary({ targetInfo, nodeVersion, nodeBinOverride, workDir }) {
  if (nodeBinOverride) {
    if (!existsSync(nodeBinOverride)) {
      throw new Error(`--node-bin does not exist: ${nodeBinOverride}`);
    }
    const versionOut = execFileSync(nodeBinOverride, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (!/^v\d+\.\d+\.\d+$/.test(versionOut)) {
      throw new Error(`unexpected --node-bin --version output: ${versionOut}`);
    }
    return {
      nodeBin: nodeBinOverride,
      nodeVersion: versionOut,
      nodeProvider: 'local-node-bin',
      nodeBinarySha256: await sha256File(nodeBinOverride),
    };
  }

  const nodePlatform = targetInfo.os === 'win32' ? 'win' : targetInfo.os;
  const dirName = `node-${nodeVersion}-${nodePlatform}-${targetInfo.arch}`;
  const cacheRoot = process.env.NODE_EXE_CACHE ?? join(tmpdir(), 'officialnode');
  const archiveName = `${dirName}.${targetInfo.isWindows ? 'zip' : 'tar.gz'}`;
  const archivePath = join(cacheRoot, archiveName);
  const archiveTemp = `${archivePath}.${process.pid}.tmp`;
  const shasumsPath = join(workDir, `SHASUMS256-${nodeVersion}.txt`);
  const nodeBin = targetInfo.isWindows
    ? join(cacheRoot, dirName, 'node.exe')
    : join(cacheRoot, dirName, 'bin', 'node');

  await mkdir(cacheRoot, { recursive: true });
  await mkdir(workDir, { recursive: true });

  await downloadFile(`${OFFICIAL_NODE_DIST}/${nodeVersion}/SHASUMS256.txt`, shasumsPath, 'error');
  if (!existsSync(archivePath)) {
    await rm(archiveTemp, { force: true });
    await downloadFile(`${NODE_MIRROR}/${nodeVersion}/${archiveName}`, archiveTemp);
    await rename(archiveTemp, archivePath);
  }
  const nodeArchiveSha256 = await verifyOfficialNodeArtifact(
    archivePath,
    archiveName,
    await readFile(shasumsPath, 'utf8'),
  );

  removeDirForceSync(join(cacheRoot, dirName));
  extractArchiveToDir(archivePath, targetInfo.isWindows ? 'zip' : 'tar.gz', cacheRoot, {
    stdio: 'inherit',
  });
  if (!existsSync(nodeBin)) {
    throw new Error(`verified Node archive did not contain ${nodeBin}`);
  }
  return {
    nodeBin,
    nodeVersion,
    nodeProvider: 'official-node',
    nodeArchive: archiveName,
    nodeArchiveSha256,
  };
}

function buildRuntimePackageJson(sourcePackageJson) {
  const pkg = {
    name: sourcePackageJson.name,
    version: sourcePackageJson.version,
    description: sourcePackageJson.description,
    license: sourcePackageJson.license,
    ...(sourcePackageJson.repository ? { repository: sourcePackageJson.repository } : {}),
    bin: sourcePackageJson.bin,
    type: sourcePackageJson.type,
    main: sourcePackageJson.main,
    engines: sourcePackageJson.engines,
    scripts: {},
    dependencies: sourcePackageJson.dependencies ?? {},
    ...(sourcePackageJson.optionalDependencies ? { optionalDependencies: sourcePackageJson.optionalDependencies } : {}),
    ...(sourcePackageJson.overrides ? { overrides: sourcePackageJson.overrides } : {}),
    ...(sourcePackageJson.bundleDependencies ? { bundleDependencies: sourcePackageJson.bundleDependencies } : {}),
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function stageProductionNodeModules(sourceNodeModules, destNodeModules, packageLock, targetInfo) {
  if (!existsSync(sourceNodeModules)) {
    throw new Error(`source node_modules does not exist: ${sourceNodeModules}`);
  }
  const lockPackages = packageLock.packages ?? {};
  mkdirSync(destNodeModules, { recursive: true });

  const copyFilter = (src) => {
    const lst = lstatSync(src);
    if (lst.isSymbolicLink()) return false;
    const base = src.split(/[\\/]/).pop() ?? '';
    if (base === '.bin' || base === '.cache') return false;

    const relFromSourceNm = relative(sourceNodeModules, src).replaceAll('\\', '/');
    if (!relFromSourceNm) return true;
    const lockKey = `node_modules/${relFromSourceNm}`;
    // Check nested package boundaries when lockfile explicitly describes them.
    if (relFromSourceNm.includes('/node_modules/')) {
      const nestedTail = lockKey.slice(lockKey.lastIndexOf('node_modules/') + 'node_modules/'.length);
      const segments = nestedTail.split('/');
      const isPkgRoot = segments.length === 1 || (segments[0].startsWith('@') && segments.length === 2);
      if (isPkgRoot && lockPackages[lockKey]) {
        return shouldKeepPackageLockEntry(lockKey, lockPackages[lockKey], targetInfo);
      }
    }
    return true;
  };

  for (const [lockKey, pkgMeta] of Object.entries(lockPackages)) {
    if (!lockKey.startsWith('node_modules/')) continue;
    const rel = lockKey.slice('node_modules/'.length);
    if (rel.includes('node_modules/')) continue;
    if (!shouldKeepPackageLockEntry(lockKey, pkgMeta, targetInfo)) continue;

    const srcPkgDir = join(sourceNodeModules, ...rel.split('/'));
    if (!existsSync(srcPkgDir)) continue;
    const destPkgDir = join(destNodeModules, ...rel.split('/'));
    mkdirSync(dirname(destPkgDir), { recursive: true });
    cpSync(srcPkgDir, destPkgDir, { recursive: true, dereference: false, filter: copyFilter });
  }

  return pruneStagedNodeModulesForTarget(destNodeModules, targetInfo);
}

function readUInt32(buf, offset, littleEndian) {
  return littleEndian ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
}

function machoSupportsArch(filePath, targetArch) {
  const expectedCpu = targetArch === 'x64' ? 0x01000007 : 0x0100000c;
  const fd = openSync(filePath, 'r');
  try {
    const header = Buffer.allocUnsafe(1024);
    const bytesRead = readSync(fd, header, 0, header.length, 0);
    if (bytesRead < 8) return false;
    const beMagic = header.readUInt32BE(0);
    // Thin Mach-O 64-bit: 0xfeedfacf (BE) or 0xcffaedfe (LE -> CPU_TYPE at offset 4)
    if (beMagic === 0xfeedfacf || beMagic === 0xcffaedfe) {
      return readUInt32(header, 4, beMagic === 0xcffaedfe) === expectedCpu;
    }
    // Thin Mach-O 32-bit: 0xfeedface (BE) or 0xcefaedfe (LE)
    if (beMagic === 0xfeedface || beMagic === 0xcefaedfe) {
      return readUInt32(header, 4, beMagic === 0xcefaedfe) === expectedCpu;
    }
    // Universal/Fat Mach-O: 0xcafebabe (BE) or 0xbebafeca (swapped)
    if (beMagic === 0xcafebabe || beMagic === 0xbebafeca) {
      const nfat = header.readUInt32BE(4);
      const limit = Math.min(nfat, Math.floor((bytesRead - 8) / 20));
      for (let i = 0; i < limit; i += 1) {
        if (header.readUInt32BE(8 + i * 20) === expectedCpu) return true;
      }
      return false;
    }
    return false;
  } finally {
    closeSync(fd);
  }
}

function verifyStagedDarwinNativeBinaries(packageDir, targetInfo) {
  if (targetInfo.os !== 'darwin') return;
  const nodeModulesDir = join(packageDir, 'node_modules');
  if (!existsSync(nodeModulesDir)) return;

  if (existsSync(join(nodeModulesDir, 'sharp'))) {
    const sharpPkg = join(nodeModulesDir, '@img', `sharp-darwin-${targetInfo.arch}`);
    if (!existsSync(sharpPkg)) {
      throw new Error(
        `darwin-${targetInfo.arch} daemon-runtime is missing @img/sharp-darwin-${targetInfo.arch}; `
        + `pass --source-node-modules staged for darwin-${targetInfo.arch}`,
      );
    }
  }

  for (const { path } of walkRegularFiles(nodeModulesDir)) {
    const ext = extname(path).toLowerCase();
    if (ext !== '.node' && ext !== '.dylib') continue;
    if (!isMachOBinary(path)) continue;
    if (!machoSupportsArch(path, targetInfo.arch)) {
      throw new Error(
        `staged native binary ${path} does not support target darwin-${targetInfo.arch}; `
        + `pass --source-node-modules staged for darwin-${targetInfo.arch}`,
      );
    }
  }
}

function isMachOBinary(filePath) {
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(4);
    const bytesRead = readSync(fd, buf, 0, 4, 0);
    if (bytesRead < 4) return false;
    const magic = buf.readUInt32BE(0);
    return magic === 0xfeedface
      || magic === 0xfeedfacf
      || magic === 0xcefaedfe
      || magic === 0xcffaedfe
      || magic === 0xcafebabe
      || magic === 0xbebafeca;
  } finally {
    closeSync(fd);
  }
}

function walkRegularFiles(dir) {
  const results = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const entry of readdirSync(cur)) {
      const abs = join(cur, entry);
      const lst = lstatSync(abs);
      if (lst.isDirectory()) stack.push(abs);
      else if (lst.isFile()) results.push({ path: abs, mode: lst.mode });
    }
  }
  return results;
}

function normalizePosixExecutableBits(stageDir) {
  for (const entry of walkRegularFiles(stageDir)) {
    const ext = extname(entry.path).toLowerCase();
    const isBinaryOrScript = entry.path === join(stageDir, 'bin', 'node')
      || ext === '.node'
      || ext === '.dylib'
      || ext === '.sh'
      || entry.path.endsWith('/spawn-helper')
      || /\.so(?:\.\d+)*$/.test(entry.path)
      || (entry.mode & 0o111) !== 0;
    chmodSync(entry.path, isBinaryOrScript ? 0o755 : 0o644);
  }
}

function signMacosBundle(stageDir) {
  if (process.platform !== 'darwin') return undefined;
  const identity = process.env.IMCODES_MACOS_SIGNING_IDENTITY?.trim() ?? '';
  if (identity && !/^[A-F0-9]{40}$/i.test(identity)) {
    throw new Error('IMCODES_MACOS_SIGNING_IDENTITY must be a SHA-1 fingerprint');
  }
  const nodePath = join(stageDir, 'bin', 'node');
  const entitlementsPath = join(repoRoot, 'native', 'macos-node', 'daemon-runtime.entitlements');

  // Sign embedded native binaries inside-out before signing bin/node, leaving
  // upstream Apple-notarized .app bundles under computer-use-helper untouched.
  const cuHelperRoot = `${join(stageDir, 'package', 'dist', 'computer-use-helper')}/`;
  const packageMachOs = walkRegularFiles(join(stageDir, 'package'))
    .filter(({ path, mode }) => {
      if (path.startsWith(cuHelperRoot)) return false;
      const ext = extname(path).toLowerCase();
      return ext === '.node'
        || ext === '.dylib'
        || /\.so(?:\.\d+)*$/.test(path)
        || (mode & 0o111) !== 0;
    })
    .filter(({ path }) => isMachOBinary(path))
    .map(({ path }) => path);

  for (const binary of packageMachOs) {
    if (!identity) {
      sh('codesign', ['--force', '--sign', '-', binary]);
    } else {
      sh('codesign', ['--force', '--timestamp', '--options', 'runtime', '--sign', identity, binary]);
    }
  }

  if (!identity) {
    sh('codesign', ['--force', '--sign', '-', nodePath]);
    return undefined;
  }

  sh('codesign', [
    '--force',
    '--timestamp',
    '--options', 'runtime',
    '--entitlements', entitlementsPath,
    '--sign', identity,
    nodePath,
  ]);
  sh('codesign', ['--verify', '--strict', '--verbose=2', nodePath]);
  return identity.toLowerCase();
}

function signWindowsBundle(stageDir) {
  if (process.platform !== 'win32') return undefined;
  const thumbprint = process.env.IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT?.trim() ?? '';
  const signerSha256 = process.env.IMCODES_WINDOWS_SIGNING_CERT_SHA256?.trim().toLowerCase() ?? '';
  if (Boolean(thumbprint) !== Boolean(signerSha256)) {
    throw new Error(
      'Windows daemon-runtime signing requires both IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT and IMCODES_WINDOWS_SIGNING_CERT_SHA256',
    );
  }
  if (!thumbprint) {
    // Keep official node.exe's upstream signature when no CI cert is configured.
    return undefined;
  }
  if (!/^[a-f0-9]{40}$/i.test(thumbprint)) {
    throw new Error('IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT must be SHA-1 hex');
  }
  if (!/^[a-f0-9]{64}$/.test(signerSha256)) {
    throw new Error('IMCODES_WINDOWS_SIGNING_CERT_SHA256 must be lowercase SHA-256 hex');
  }
  const systemRoot = process.env.SystemRoot?.trim();
  if (!systemRoot) throw new Error('SystemRoot is required to locate Windows PowerShell');
  const ps = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const timestampUrl = process.env.IMCODES_WINDOWS_SIGNING_TIMESTAMP_URL?.trim() || 'http://timestamp.digicert.com';

  const peFiles = [
    join(stageDir, 'node.exe'),
    ...walkRegularFiles(join(stageDir, 'package'))
      .filter(({ path }) => {
        const ext = extname(path).toLowerCase();
        return ext === '.exe' || ext === '.dll';
      })
      .map(({ path }) => path),
  ];

  for (const artifactPath of peFiles) {
    sh(ps, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', join(repoRoot, 'scripts', 'windows-sign-release-artifact.ps1'),
      '-Mode', 'Sign',
      '-ArtifactPath', artifactPath,
      '-CodeSigningCertificateThumbprint', thumbprint,
      '-ExpectedSignerSha256', signerSha256,
      '-TimestampUrl', timestampUrl,
    ]);
  }
  return signerSha256;
}

function createBundleArchive(stageDir, archivePath, targetInfo) {
  rmSync(archivePath, { force: true });
  const topEntries = readdirSync(stageDir).sort();
  createArchiveFromDir(stageDir, archivePath, targetInfo.archiveFormat, {
    stdio: 'inherit',
    topEntries,
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { targetInfo } = opts;

  if (!opts.skipBuild) {
    sh(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: repoRoot });
  }
  if (!existsSync(join(repoRoot, 'dist', 'src', 'index.js'))) {
    throw new Error('dist/src/index.js missing; run `npm run build` or omit --skip-build');
  }

  const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(await readFile(join(repoRoot, 'package-lock.json'), 'utf8'));
  const rawVersion = opts.buildVersion || (typeof packageJson.version === 'string' ? packageJson.version : '0.0.0');
  const buildVersion = normalizeNodeExeBuildVersion(rawVersion);
  const buildCommit = (process.env.GITHUB_SHA
    ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' })).trim();

  const workDir = mkdtempSync(join(tmpdir(), `imcodes-daemon-runtime-${targetInfo.target}-`));
  const stageDir = opts.stageDir || join(workDir, 'stage');
  try {
    removeDirForceSync(stageDir);
    mkdirSync(stageDir, { recursive: true });
    mkdirSync(opts.outDir, { recursive: true });

    const nodeInfo = await resolveNodeBinary({
      targetInfo,
      nodeVersion: opts.nodeVersion,
      nodeBinOverride: opts.nodeBin,
      workDir,
    });

    const destNodePath = join(stageDir, ...targetInfo.nodeRelativePath.split('/'));
    await mkdir(dirname(destNodePath), { recursive: true });
    await copyFile(nodeInfo.nodeBin, destNodePath);

    const packageDir = join(stageDir, 'package');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), buildRuntimePackageJson(packageJson));
    cpSync(join(repoRoot, 'dist'), join(packageDir, 'dist'), {
      recursive: true,
      dereference: false,
      filter: (src) => !lstatSync(src).isSymbolicLink(),
    });
    cpSync(join(repoRoot, 'config'), join(packageDir, 'config'), { recursive: true, dereference: false });
    if (existsSync(join(repoRoot, 'bin'))) {
      cpSync(join(repoRoot, 'bin'), join(packageDir, 'bin'), { recursive: true, dereference: false });
    }

    let sourceNodeModulesDir = opts.sourceNodeModules;
    if (
      process.platform === 'darwin'
      && targetInfo.os === 'darwin'
      && targetInfo.arch !== process.arch
      && !opts.explicitSourceNodeModules
    ) {
      const npmCli = resolve(dirname(nodeInfo.nodeBin), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (!existsSync(npmCli)) {
        throw new Error(
          `cannot cross-stage darwin-${targetInfo.arch} node_modules automatically without bundled npm at ${npmCli}; pass --source-node-modules <dir>`,
        );
      }
      const crossDir = join(workDir, 'cross-node-modules');
      mkdirSync(crossDir, { recursive: true });
      cpSync(join(repoRoot, 'package.json'), join(crossDir, 'package.json'));
      cpSync(join(repoRoot, 'package-lock.json'), join(crossDir, 'package-lock.json'));
      const crossEnv = {
        ...process.env,
        HUSKY: '0',
        PATH: `${dirname(nodeInfo.nodeBin)}:${join(repoRoot, 'node_modules', '.bin')}:${process.env.PATH ?? ''}`,
      };
      execFileSync(
        nodeInfo.nodeBin,
        [npmCli, 'ci', '--omit=dev', `--cpu=${targetInfo.arch}`, '--no-audit', '--no-fund'],
        { cwd: crossDir, env: crossEnv, stdio: 'inherit' },
      );
      sourceNodeModulesDir = join(crossDir, 'node_modules');
    }

    const pruneStats = stageProductionNodeModules(
      sourceNodeModulesDir,
      join(packageDir, 'node_modules'),
      packageLock,
      targetInfo,
    );

    if (targetInfo.os === 'darwin') {
      const cuBase = join(packageDir, 'dist', 'computer-use-helper');
      const targetCuDir = join(cuBase, targetInfo.target);
      if (existsSync(cuBase) && !existsSync(targetCuDir)) {
        for (const fallbackKey of ['darwin-universal', 'darwin-arm64', 'darwin-x64']) {
          const fallbackDir = join(cuBase, fallbackKey);
          if (existsSync(fallbackDir)) {
            cpSync(fallbackDir, targetCuDir, { recursive: true, dereference: false });
            rmSync(fallbackDir, { recursive: true, force: true });
            break;
          }
        }
      }
      verifyStagedDarwinNativeBinaries(packageDir, targetInfo);
    }

    if (!targetInfo.isWindows) {
      normalizePosixExecutableBits(stageDir);
    }

    const macosSigningIdentitySha1 = targetInfo.os === 'darwin' ? signMacosBundle(stageDir) : undefined;
    const authenticodeSignerSha256 = targetInfo.os === 'win32' ? signWindowsBundle(stageDir) : undefined;

    const preFilesDoc = await createDaemonRuntimeFilesDocument({
      bundleRoot: stageDir,
      os: targetInfo.os,
      arch: targetInfo.arch,
      nodeVersion: nodeInfo.nodeVersion,
      nodeProvider: nodeInfo.nodeProvider,
      nodeArchive: nodeInfo.nodeArchive,
      nodeArchiveSha256: nodeInfo.nodeArchiveSha256,
      nodeBinarySha256: nodeInfo.nodeBinarySha256,
      buildCommit,
      buildVersion,
    });
    await writeDaemonRuntimeJson(join(stageDir, DAEMON_RUNTIME_FILES_FILENAME), preFilesDoc);

    const archiveBaseName = `daemon-runtime-${targetInfo.target}`;
    const archivePath = join(opts.outDir, `${archiveBaseName}.${targetInfo.archiveFormat}`);
    const manifestPath = join(opts.outDir, `${archiveBaseName}.manifest.json`);

    createBundleArchive(stageDir, archivePath, targetInfo);

    const { manifest } = await createDaemonRuntimeManifest({
      bundleRoot: stageDir,
      archivePath,
      os: targetInfo.os,
      arch: targetInfo.arch,
      nodeVersion: nodeInfo.nodeVersion,
      nodeProvider: nodeInfo.nodeProvider,
      nodeArchive: nodeInfo.nodeArchive,
      nodeArchiveSha256: nodeInfo.nodeArchiveSha256,
      nodeBinarySha256: nodeInfo.nodeBinarySha256,
      buildCommit,
      buildVersion,
      authenticodeSignerSha256,
      macosSigningIdentitySha1,
      filesDocument: preFilesDoc,
    });
    await writeDaemonRuntimeJson(manifestPath, manifest);

    const verified = await verifyDaemonRuntimeArchive(manifestPath, {
      requireOfficialNode: nodeInfo.nodeProvider === 'official-node',
    });

    const compressedMb = (verified.artifact.size / 1048576).toFixed(2);
    const uncompressedMb = (verified.totalUncompressedBytes / 1048576).toFixed(2);
    const prunedMb = (pruneStats.bytesRemoved / 1048576).toFixed(2);
    console.log(
      `✅ built & verified ${verified.artifact.fileName} (${verified.fileCount} files, `
      + `${uncompressedMb} MB uncompressed, ${compressedMb} MB compressed, pruned ${prunedMb} MB)\n`
      + `✅ wrote verified manifest at ${manifestPath}`,
    );
  } finally {
    if (!opts.keepStaging) {
      removeDirForceSync(workDir);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((err) => {
    console.error('build-daemon-runtime failed:', err?.message ?? err);
    process.exit(1);
  });
}
