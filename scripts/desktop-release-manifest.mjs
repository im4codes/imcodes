#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  assertDaemonRuntimeManifestShape,
  parseDaemonRuntimeTarget,
} from './daemon-runtime-artifacts.mjs';
import { normalizeNodeExeBuildVersion, sha256File } from './node-exe-artifacts.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, '..');

let cachedReleaseManifestMod;
export async function loadDesktopReleaseManifestModule() {
  if (cachedReleaseManifestMod) return cachedReleaseManifestMod;
  const distPath = join(REPO_ROOT, 'dist', 'shared', 'desktop-release-manifest.js');
  if (existsSync(distPath)) {
    cachedReleaseManifestMod = await import(distPath);
    return cachedReleaseManifestMod;
  }
  try {
    cachedReleaseManifestMod = await import('../shared/desktop-release-manifest.js');
    return cachedReleaseManifestMod;
  } catch (err) {
    throw new Error(
      `Desktop release manifest module not built at ${distPath}. Run "npm run build" first (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJsonAtomic(filePath, value) {
  const absPath = resolve(filePath);
  mkdirSync(dirname(absPath), { recursive: true });
  const tmpPath = `${absPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, absPath);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

export function resolveGitSha(explicitSha) {
  if (explicitSha && String(explicitSha).trim()) {
    return String(explicitSha).trim().toLowerCase();
  }
  const envSha = process.env.GITHUB_SHA?.trim();
  if (envSha) return envSha.toLowerCase();
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim().toLowerCase();
}

function resolveFileCandidate(distDir, candidates) {
  for (const relPath of candidates) {
    const absPath = join(distDir, relPath);
    if (existsSync(absPath) && statSync(absPath).isFile()) {
      return { relPath: relPath.replace(/\\/gu, '/'), absPath };
    }
  }
  return null;
}

async function readOptionalSidecarManifest(distDir, relPath) {
  const absPath = join(distDir, relPath);
  if (!existsSync(absPath) || !statSync(absPath).isFile()) return null;
  return {
    relPath: relPath.replace(/\\/gu, '/'),
    absPath,
    fileName: basename(absPath),
    sha256: await sha256File(absPath),
    json: readJson(absPath),
  };
}

async function buildTargetBundle({ distDir, target, releaseVersion }) {
  const runtimeTarget = parseDaemonRuntimeTarget(target);
  const { os, arch } = runtimeTarget;

  // 1. imcodes-node
  const nodeFileName =
    os === 'win32'
      ? 'imcodes-node.exe'
      : os === 'darwin'
        ? 'imcodes-node-macos'
        : arch === 'arm64'
          ? 'imcodes-node-linux-arm64'
          : 'imcodes-node-linux';
  const nodeCandidate = resolveFileCandidate(distDir, [nodeFileName]);
  if (!nodeCandidate) {
    throw new Error(`missing imcodes-node artifact for ${target}: ${join(distDir, nodeFileName)}`);
  }
  const nodeSidecar = await readOptionalSidecarManifest(distDir, `${nodeCandidate.relPath}.manifest.json`);
  const nodeVersion = nodeSidecar?.json?.build?.version
    ? normalizeNodeExeBuildVersion(nodeSidecar.json.build.version)
    : releaseVersion;
  const nodeSha = await sha256File(nodeCandidate.absPath);
  const nodeStat = statSync(nodeCandidate.absPath);
  const nodeSigner =
    typeof nodeSidecar?.json?.artifact?.authenticodeSignerSha256 === 'string'
      ? nodeSidecar.json.artifact.authenticodeSignerSha256.toLowerCase()
      : undefined;

  const nodeEntry = {
    component: 'imcodes-node',
    version: nodeVersion,
    fileName: basename(nodeCandidate.absPath),
    relativePath: nodeCandidate.relPath,
    sha256: nodeSha,
    sizeBytes: nodeStat.size,
    ...(nodeSidecar ? { manifestFileName: nodeSidecar.fileName, manifestSha256: nodeSidecar.sha256 } : {}),
    compat: {
      os,
      arch: os === 'darwin' ? 'universal' : arch,
      abiProfile: nodeSidecar?.json?.artifact?.abiProfile ?? 'modern',
      ...(nodeSigner ? { authenticodeSignerSha256: nodeSigner } : {}),
    },
  };

  // 2. remote-desktop
  let rdCandidate;
  let rdSidecar;
  let rdVersion;
  let rdProtocolVersion;
  let rdSigner;
  if (os === 'win32') {
    rdCandidate = resolveFileCandidate(distDir, ['remote-desktop-worker/win32-x64/imcodes-remote-desktop-worker.exe']);
    rdSidecar = await readOptionalSidecarManifest(
      distDir,
      'remote-desktop-worker/win32-x64/imcodes-remote-desktop-worker.exe.manifest.json',
    );
    if (!rdCandidate || !rdSidecar) {
      throw new Error(`missing Windows remote-desktop worker or manifest in ${distDir}`);
    }
    rdVersion = normalizeNodeExeBuildVersion(rdSidecar.json.workerVersion);
    rdProtocolVersion = rdSidecar.json.protocolVersion;
    rdSigner =
      typeof rdSidecar.json.authenticodeSignerSha256 === 'string'
        ? rdSidecar.json.authenticodeSignerSha256.toLowerCase()
        : undefined;
  } else if (os === 'darwin') {
    rdCandidate = resolveFileCandidate(distDir, [`remote-desktop-worker/darwin-${arch}/imcodes-remote-desktop-worker`]);
    rdSidecar = await readOptionalSidecarManifest(
      distDir,
      `remote-desktop-worker/darwin-${arch}/imcodes-remote-desktop.manifest.json`,
    );
    if (!rdCandidate || !rdSidecar) {
      throw new Error(`missing macOS remote-desktop worker or manifest for ${target} in ${distDir}`);
    }
    rdVersion = normalizeNodeExeBuildVersion(rdSidecar.json.workerVersion);
    rdProtocolVersion = rdSidecar.json.protocolVersion;
  } else {
    rdCandidate = resolveFileCandidate(distDir, [
      `remote-desktop-worker/linux-${arch}/imcodes-linux-remote-desktop-worker`,
      'remote-desktop-worker/linux-x64/imcodes-linux-remote-desktop-worker',
    ]);
    rdSidecar = await readOptionalSidecarManifest(
      distDir,
      `${rdCandidate?.relPath ?? `remote-desktop-worker/linux-${arch}/imcodes-linux-remote-desktop-worker`}.manifest.json`,
    );
    if (!rdCandidate || !rdSidecar) {
      throw new Error(`missing Linux remote-desktop worker or manifest for ${target} in ${distDir}`);
    }
    rdVersion = normalizeNodeExeBuildVersion(rdSidecar.json?.build?.version ?? releaseVersion);
    rdProtocolVersion = rdSidecar.json?.protocolVersion ?? 2;
  }
  const rdStat = statSync(rdCandidate.absPath);
  const rdEntry = {
    component: 'remote-desktop',
    version: rdVersion,
    fileName: basename(rdCandidate.absPath),
    relativePath: rdCandidate.relPath,
    sha256: await sha256File(rdCandidate.absPath),
    sizeBytes: rdStat.size,
    ...(rdSidecar ? { manifestFileName: rdSidecar.fileName, manifestSha256: rdSidecar.sha256 } : {}),
    compat: {
      os,
      arch,
      ...(typeof rdProtocolVersion === 'number' ? { protocolVersion: rdProtocolVersion } : {}),
      ...(rdSigner ? { authenticodeSignerSha256: rdSigner } : {}),
    },
  };

  // 3. open-computer-use
  const cuFileName =
    os === 'win32' ? 'open-computer-use.exe' : os === 'darwin' ? 'open-computer-use.app.zip' : 'open-computer-use';
  const cuCandidates =
    os === 'darwin'
      ? [`computer-use-helper/darwin-universal/${cuFileName}`, `computer-use-helper/darwin-${arch}/${cuFileName}`]
      : [`computer-use-helper/${os}-${arch}/${cuFileName}`];
  const cuCandidate = resolveFileCandidate(distDir, cuCandidates);
  if (!cuCandidate) {
    throw new Error(`missing open-computer-use artifact for ${target} in ${distDir}`);
  }
  const cuSidecar = await readOptionalSidecarManifest(distDir, `${cuCandidate.relPath}.manifest.json`);
  const cuVersion = cuSidecar?.json?.build?.version
    ? normalizeNodeExeBuildVersion(cuSidecar.json.build.version)
    : releaseVersion;
  const cuSigner =
    typeof cuSidecar?.json?.artifact?.authenticodeSignerSha256 === 'string'
      ? cuSidecar.json.artifact.authenticodeSignerSha256.toLowerCase()
      : undefined;
  const cuStat = statSync(cuCandidate.absPath);
  const cuEntry = {
    component: 'open-computer-use',
    version: cuVersion,
    fileName: basename(cuCandidate.absPath),
    relativePath: cuCandidate.relPath,
    sha256: await sha256File(cuCandidate.absPath),
    sizeBytes: cuStat.size,
    ...(cuSidecar ? { manifestFileName: cuSidecar.fileName, manifestSha256: cuSidecar.sha256 } : {}),
    compat: {
      os,
      arch: os === 'darwin' ? 'universal' : arch,
      ...(cuSigner ? { authenticodeSignerSha256: cuSigner } : {}),
    },
  };

  // 4. daemon-runtime
  const drManifestRel = `daemon-runtime/daemon-runtime-${target}.manifest.json`;
  const drSidecar = await readOptionalSidecarManifest(distDir, drManifestRel);
  if (!drSidecar) {
    throw new Error(`missing daemon-runtime manifest for ${target}: ${join(distDir, drManifestRel)}`);
  }
  const drManifest = assertDaemonRuntimeManifestShape(drSidecar.json, drSidecar.absPath);
  const drArchiveRel = `daemon-runtime/${drManifest.artifact.fileName}`;
  const drCandidate = resolveFileCandidate(distDir, [drArchiveRel]);
  if (!drCandidate) {
    throw new Error(`missing daemon-runtime archive for ${target}: ${join(distDir, drArchiveRel)}`);
  }
  const drArchiveStat = statSync(drCandidate.absPath);
  const drArchiveSha = await sha256File(drCandidate.absPath);
  if (drArchiveSha !== drManifest.artifact.sha256 || drArchiveStat.size !== drManifest.artifact.size) {
    throw new Error(`daemon-runtime archive mismatch with ${drSidecar.absPath}`);
  }
  const drSigner =
    typeof drManifest.artifact.authenticodeSignerSha256 === 'string'
      ? drManifest.artifact.authenticodeSignerSha256.toLowerCase()
      : undefined;
  const drEntry = {
    component: 'daemon-runtime',
    version: normalizeNodeExeBuildVersion(drManifest.build.version),
    fileName: basename(drCandidate.absPath),
    relativePath: drCandidate.relPath,
    sha256: drArchiveSha,
    sizeBytes: drArchiveStat.size,
    manifestFileName: drSidecar.fileName,
    manifestSha256: drSidecar.sha256,
    compat: {
      os,
      arch,
      nodeVersion: drManifest.toolchain.nodeVersion,
      ...(drSigner ? { authenticodeSignerSha256: drSigner } : {}),
      ...(drManifest.artifact.macosSigningIdentitySha1
        ? { macosSigningIdentitySha1: drManifest.artifact.macosSigningIdentitySha1 }
        : {}),
    },
  };

  // 5. Optional installers
  const installers = [];
  const installerSpecs =
    os === 'linux'
      ? [
          {
            kind: 'deb',
            relPath: `installers/imcodes-desktop-${releaseVersion}-linux-${arch === 'arm64' ? 'arm64' : 'amd64'}.deb`,
          },
          { kind: 'sh', relPath: `installers/imcodes-desktop-${releaseVersion}-linux-${arch}.sh` },
        ]
      : os === 'darwin'
        ? [{ kind: 'pkg', relPath: `installers/imcodes-desktop-${releaseVersion}-darwin-${arch}.pkg` }]
        : [{ kind: 'exe', relPath: `installers/imcodes-desktop-${releaseVersion}-win32-${arch}.exe` }];

  for (const spec of installerSpecs) {
    const found = resolveFileCandidate(distDir, [spec.relPath]);
    if (!found) continue;
    const instSidecar = await readOptionalSidecarManifest(distDir, `${found.relPath}.manifest.json`);
    installers.push({
      kind: spec.kind,
      fileName: basename(found.absPath),
      relativePath: found.relPath,
      sha256: await sha256File(found.absPath),
      sizeBytes: statSync(found.absPath).size,
      version: releaseVersion,
      ...(instSidecar ? { manifestFileName: instSidecar.fileName } : {}),
    });
  }

  return {
    target,
    os,
    arch,
    components: {
      'imcodes-node': nodeEntry,
      'remote-desktop': rdEntry,
      'open-computer-use': cuEntry,
      'daemon-runtime': drEntry,
    },
    ...(installers.length > 0 ? { installers } : {}),
  };
}

export async function buildDesktopReleaseManifest(options) {
  const mod = await loadDesktopReleaseManifestModule();
  const distDir = resolve(options.distDir ?? join(REPO_ROOT, 'dist-node-exe'));
  const releaseVersion = normalizeNodeExeBuildVersion(options.releaseVersion);
  const gitSha = resolveGitSha(options.gitSha);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const compatRules = options.compatRules;

  if (Array.isArray(options.mergeManifestPaths) && options.mergeManifestPaths.length > 0) {
    const inputs = options.mergeManifestPaths.map((p) => readJson(resolve(p)));
    const merged = mod.mergeDesktopReleaseManifests(inputs, generatedAt);
    if (options.outPath) writeJsonAtomic(options.outPath, merged);
    return merged;
  }

  const targetList = Array.isArray(options.targets)
    ? options.targets
    : options.target
      ? [options.target]
      : [];
  if (targetList.length === 0) {
    throw new Error('at least one --target is required');
  }

  const targets = {};
  for (const target of targetList) {
    targets[target] = await buildTargetBundle({ distDir, target, releaseVersion });
  }

  const manifest = mod.validateDesktopReleaseManifest({
    schemaVersion: mod.DESKTOP_RELEASE_MANIFEST_SCHEMA_VERSION,
    releaseVersion,
    gitSha,
    generatedAt,
    ...(compatRules?.length ? { compatRules } : {}),
    targets,
  });

  if (options.outPath) {
    writeJsonAtomic(options.outPath, manifest);
  }
  return manifest;
}

export async function verifyDesktopReleaseManifest(manifestPath, options = {}) {
  const mod = await loadDesktopReleaseManifestModule();
  const absManifestPath = resolve(manifestPath);
  const raw = readJson(absManifestPath);
  const manifest = mod.validateDesktopReleaseManifest(raw);

  if (options.expectedVersion) {
    const normalizedExpected = normalizeNodeExeBuildVersion(options.expectedVersion);
    if (manifest.releaseVersion !== normalizedExpected) {
      throw new Error(
        `desktop release manifest version mismatch: expected ${normalizedExpected}, got ${manifest.releaseVersion}`,
      );
    }
  }
  if (options.expectedGitSha) {
    const expectedSha = String(options.expectedGitSha).trim().toLowerCase();
    if (manifest.gitSha !== expectedSha) {
      throw new Error(`desktop release manifest gitSha mismatch: expected ${expectedSha}, got ${manifest.gitSha}`);
    }
  }
  if (options.target && !manifest.targets[options.target]) {
    throw new Error(`desktop release manifest missing target: ${options.target}`);
  }

  const distDir = resolve(options.distDir ?? dirname(absManifestPath));
  if (options.verifyFiles !== false) {
    const targetEntries = options.target
      ? [[options.target, manifest.targets[options.target]]]
      : Object.entries(manifest.targets);
    for (const [targetName, bundle] of targetEntries) {
      if (!bundle) continue;
      for (const componentName of mod.DESKTOP_RELEASE_COMPONENTS) {
        const entry = bundle.components[componentName];
        const relPath = entry.relativePath ?? entry.fileName;
        const absFilePath = resolve(distDir, relPath);
        if (!existsSync(absFilePath) || !statSync(absFilePath).isFile()) {
          throw new Error(`missing component artifact for ${targetName}.${componentName}: ${absFilePath}`);
        }
        const stat = statSync(absFilePath);
        if (stat.size !== entry.sizeBytes) {
          throw new Error(
            `size mismatch for ${targetName}.${componentName}: expected ${entry.sizeBytes}, got ${stat.size}`,
          );
        }
        const actualSha = await sha256File(absFilePath);
        if (actualSha !== entry.sha256) {
          throw new Error(
            `sha256 mismatch for ${targetName}.${componentName}: expected ${entry.sha256}, got ${actualSha}`,
          );
        }
        if (entry.manifestFileName && entry.manifestSha256) {
          const manifestRel = entry.relativePath
            ? join(dirname(entry.relativePath), entry.manifestFileName)
            : entry.manifestFileName;
          const absSidecar = resolve(distDir, manifestRel);
          if (!existsSync(absSidecar)) {
            throw new Error(`missing sidecar manifest for ${targetName}.${componentName}: ${absSidecar}`);
          }
          const sidecarSha = await sha256File(absSidecar);
          if (sidecarSha !== entry.manifestSha256) {
            throw new Error(`sidecar manifest sha256 mismatch for ${targetName}.${componentName}`);
          }
        }
      }
      for (const installer of bundle.installers ?? []) {
        const relPath = installer.relativePath ?? installer.fileName;
        const absInstaller = resolve(distDir, relPath);
        if (!existsSync(absInstaller) || !statSync(absInstaller).isFile()) {
          throw new Error(`missing installer artifact for ${targetName}: ${absInstaller}`);
        }
        const stat = statSync(absInstaller);
        if (stat.size !== installer.sizeBytes) {
          throw new Error(`installer size mismatch for ${installer.fileName}`);
        }
        const actualSha = await sha256File(absInstaller);
        if (actualSha !== installer.sha256) {
          throw new Error(`installer sha256 mismatch for ${installer.fileName}`);
        }
      }
    }
  }
  return manifest;
}

function parseArgs(argv) {
  const [command = '', ...rest] = argv;
  const positional = [];
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq > 2) {
      flags[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { command, positional, flags };
}

async function main() {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const mod = await loadDesktopReleaseManifestModule();
  if (command === 'build') {
    const distDir = resolve(typeof flags['dist-dir'] === 'string' ? flags['dist-dir'] : join(REPO_ROOT, 'dist-node-exe'));
    const targets =
      typeof flags.targets === 'string'
        ? flags.targets.split(',').map((s) => s.trim()).filter(Boolean)
        : typeof flags.target === 'string'
          ? [flags.target.trim()]
          : [];
    const mergePaths =
      typeof flags.merge === 'string'
        ? flags.merge.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    const defaultOut =
      mergePaths.length > 0 || targets.length > 1
        ? join(distDir, mod.DESKTOP_RELEASE_MANIFEST_FILENAME)
        : join(distDir, mod.desktopReleaseTargetManifestFilename(targets[0]));
    const outPath = resolve(typeof flags.out === 'string' ? flags.out : defaultOut);
    const versionRaw =
      typeof flags['release-version'] === 'string'
        ? flags['release-version']
        : String(readJson(join(REPO_ROOT, 'package.json')).version);
    const manifest = await buildDesktopReleaseManifest({
      distDir,
      targets,
      mergeManifestPaths: mergePaths,
      releaseVersion: versionRaw,
      gitSha: typeof flags['git-sha'] === 'string' ? flags['git-sha'] : undefined,
      outPath,
    });
    console.log(JSON.stringify({ ok: true, outPath, releaseVersion: manifest.releaseVersion, targets: Object.keys(manifest.targets) }));
    return;
  }

  if (command === 'verify') {
    const manifestPath = positional[0] ?? flags.manifest;
    if (typeof manifestPath !== 'string' || !manifestPath) {
      throw new Error('usage: desktop-release-manifest.mjs verify <manifestPath> [--dist-dir DIR] [--expected-version VER] [--expected-git-sha SHA] [--target TARGET]');
    }
    const manifest = await verifyDesktopReleaseManifest(manifestPath, {
      distDir: typeof flags['dist-dir'] === 'string' ? flags['dist-dir'] : undefined,
      expectedVersion: typeof flags['expected-version'] === 'string' ? flags['expected-version'] : undefined,
      expectedGitSha: typeof flags['expected-git-sha'] === 'string' ? flags['expected-git-sha'] : undefined,
      target: typeof flags.target === 'string' ? flags.target : undefined,
      verifyFiles: flags['no-files'] !== true,
    });
    console.log(JSON.stringify({ ok: true, releaseVersion: manifest.releaseVersion, targets: Object.keys(manifest.targets) }));
    return;
  }

  throw new Error('usage: desktop-release-manifest.mjs <build|verify> ...');
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
