import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RELEASE_ARTIFACTS_MANIFEST_FILENAME = 'release-artifacts-manifest.json';
export const RELEASE_ARTIFACTS_MANIFEST_SCHEMA_VERSION = 1;

function sha256File(filePath) {
  const hash = createHash('sha256');
  const bytes = readFileSync(filePath);
  hash.update(bytes);
  return { sha256: hash.digest('hex'), sizeBytes: bytes.length, bytes };
}

function readJsonIfRegular(filePath) {
  if (!existsSync(filePath)) return null;
  const st = lstatSync(filePath);
  if (!st.isFile() || st.isSymbolicLink()) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function entryKey(asset, os, arch, abiProfile) {
  if (asset === 'desktop-release-manifest') {
    return os && arch ? `${asset}:${os}:${arch}` : asset;
  }
  const normOs = os ?? 'any';
  const normArch = arch ?? 'any';
  return !abiProfile || abiProfile === 'modern'
    ? `${asset}:${normOs}:${normArch}`
    : `${asset}:${normOs}:${normArch}:${abiProfile}`;
}

function stageAsset(artifactsDir, stageDir, relativePath, assetFilename) {
  if (!stageDir) return;
  mkdirSync(stageDir, { recursive: true });
  copyFileSync(join(artifactsDir, relativePath), join(stageDir, assetFilename));
}

function normalizeNodeOs(raw) {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'darwin') return 'mac';
  if (s === 'win32') return 'win';
  return s;
}

function addStaticFileEntry(artifacts, artifactsDir, stageDir, spec) {
  const fullPath = join(artifactsDir, spec.relativePath);
  if (!existsSync(fullPath)) return null;
  const st = lstatSync(fullPath);
  if (!st.isFile() || st.isSymbolicLink() || st.size <= 0) return null;
  const { sha256, sizeBytes } = sha256File(fullPath);
  const key = entryKey(spec.asset, spec.os, spec.arch, spec.abiProfile);
  const entry = {
    asset: spec.asset,
    assetFilename: spec.assetFilename,
    relativePath: spec.relativePath,
    sha256,
    sizeBytes,
    ...(spec.version ? { version: spec.version } : {}),
    ...(spec.os ? { os: spec.os } : {}),
    ...(spec.arch ? { arch: spec.arch } : {}),
    ...(spec.abiProfile && spec.abiProfile !== 'modern' ? { abiProfile: spec.abiProfile } : {}),
    ...(spec.authenticodeSignerSha256 ? { authenticodeSignerSha256: spec.authenticodeSignerSha256 } : {}),
  };
  artifacts[key] = entry;
  stageAsset(artifactsDir, stageDir, spec.relativePath, spec.assetFilename);
  return entry;
}

const RUNTIME_TARGETS = [
  { target: 'win32-x64', os: 'win', arch: 'x64' },
  { target: 'darwin-arm64', os: 'mac', arch: 'arm64' },
  { target: 'darwin-x64', os: 'mac', arch: 'x64' },
  { target: 'linux-x64', os: 'linux', arch: 'x64' },
  { target: 'linux-arm64', os: 'linux', arch: 'arm64' },
];

const SHA256_RE = /^[0-9a-f]{64}$/i;
const GIT_SHA_RE = /^[0-9a-f]{40}$/i;

function isSafeRelativeAssetPath(relPath) {
  if (typeof relPath !== 'string' || !relPath || relPath.startsWith('/') || relPath.startsWith('\\')) {
    return false;
  }
  const normalized = relPath.replace(/\\/gu, '/');
  return !normalized.split('/').some((seg) => !seg || seg === '.' || seg === '..');
}

function canonicalInstallerSpecs(target, os, version) {
  if (!version) return [];
  if (os === 'linux') {
    const rawArch = target.endsWith('-arm64') ? 'arm64' : 'x64';
    const debArch = rawArch === 'arm64' ? 'arm64' : 'amd64';
    return [
      { kind: 'deb', relativePath: `installers/imcodes-desktop-${version}-linux-${debArch}.deb` },
      { kind: 'sh', relativePath: `installers/imcodes-desktop-${version}-linux-${rawArch}.sh` },
    ];
  }
  if (os === 'mac') {
    const rawArch = target.endsWith('-x64') ? 'x64' : 'arm64';
    return [{ kind: 'pkg', relativePath: `installers/imcodes-desktop-${version}-darwin-${rawArch}.pkg` }];
  }
  if (os === 'win') {
    return [{ kind: 'exe', relativePath: `installers/imcodes-desktop-${version}-win32-x64.exe` }];
  }
  return [];
}

function mergeTargetReleaseManifests(targetManifests) {
  const first = targetManifests[0].json;
  const releaseVersion = first.releaseVersion.trim();
  const gitSha = first.gitSha.trim().toLowerCase();
  const targets = {};
  const compatRules = [];
  const seenRuleKeys = new Set();

  for (const { target, json } of targetManifests) {
    const itemVersion = json.releaseVersion.trim();
    const itemGitSha = json.gitSha.trim().toLowerCase();
    if (itemVersion !== releaseVersion) {
      throw new Error(`desktop_release_manifest_version_mismatch:${target}:${itemVersion}:${releaseVersion}`);
    }
    if (itemGitSha !== gitSha) {
      throw new Error(`desktop_release_manifest_git_sha_mismatch:${target}:${itemGitSha}:${gitSha}`);
    }
    if (Array.isArray(json.compatRules)) {
      for (const rule of json.compatRules) {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) continue;
        const ruleKey = `${rule.component}:${rule.target ?? '*'}:${rule.allowedVersion}`;
        if (!seenRuleKeys.has(ruleKey)) {
          seenRuleKeys.add(ruleKey);
          compatRules.push(rule);
        }
      }
    }
    for (const [bundleTarget, bundle] of Object.entries(json.targets ?? {})) {
      if (targets[bundleTarget]) {
        throw new Error(`desktop_release_manifest_duplicate_target:${bundleTarget}`);
      }
      targets[bundleTarget] = bundle;
    }
  }

  return {
    schemaVersion: 1,
    releaseVersion,
    gitSha,
    generatedAt: new Date().toISOString(),
    ...(compatRules.length > 0 ? { compatRules } : {}),
    targets,
  };
}

export function generateControlledNodeReleaseManifest({
  artifactsDir,
  version,
  stageDir,
  outputPath,
}) {
  const absDir = resolve(artifactsDir);
  const absStageDir = stageDir ? resolve(stageDir) : null;
  const artifacts = {};
  let detectedVersion = typeof version === 'string' && version.trim() ? version.trim() : undefined;

  const nodeSpecs = [
    { filename: 'imcodes-node.exe', os: 'win', arch: 'x64', abiProfile: 'modern' },
    { filename: 'imcodes-node-macos', os: 'mac', arch: 'universal', abiProfile: 'modern' },
    { filename: 'imcodes-node-linux', os: 'linux', arch: 'x64', abiProfile: 'modern' },
    { filename: 'imcodes-node-linux-glibc217', os: 'linux', arch: 'x64', abiProfile: 'glibc217' },
  ];

  for (const spec of nodeSpecs) {
    const manifestJson = readJsonIfRegular(join(absDir, `${spec.filename}.manifest.json`));
    if (!manifestJson || manifestJson.schemaVersion !== 1 || !manifestJson.artifact) continue;
    const art = manifestJson.artifact;
    if (art.fileName !== spec.filename || normalizeNodeOs(art.os) !== spec.os || art.arch !== spec.arch) continue;
    const binPath = join(absDir, spec.filename);
    if (!existsSync(binPath)) continue;
    const st = lstatSync(binPath);
    if (!st.isFile() || st.isSymbolicLink() || st.size <= 0) continue;
    const { sha256, sizeBytes } = sha256File(binPath);
    if (typeof art.sha256 === 'string' && art.sha256.toLowerCase() !== sha256) {
      throw new Error(`node_manifest_sha256_mismatch:${spec.filename}`);
    }
    if (typeof art.size === 'number' && art.size !== sizeBytes) {
      throw new Error(`node_manifest_size_mismatch:${spec.filename}`);
    }
    const buildVersion = typeof manifestJson.build?.version === 'string' && manifestJson.build.version.trim()
      ? manifestJson.build.version.trim()
      : detectedVersion;
    if (!detectedVersion && buildVersion) detectedVersion = buildVersion;
    const signer = typeof art.authenticodeSignerSha256 === 'string' && /^[0-9a-f]{64}$/i.test(art.authenticodeSignerSha256)
      ? art.authenticodeSignerSha256.toLowerCase()
      : undefined;
    const key = entryKey('node', spec.os, spec.arch, spec.abiProfile);
    artifacts[key] = {
      asset: 'node',
      assetFilename: spec.filename,
      relativePath: spec.filename,
      sha256,
      sizeBytes,
      ...(buildVersion ? { version: buildVersion } : {}),
      os: spec.os,
      arch: spec.arch,
      ...(spec.abiProfile !== 'modern' ? { abiProfile: spec.abiProfile } : {}),
      ...(signer ? { authenticodeSignerSha256: signer } : {}),
    };
    stageAsset(absDir, absStageDir, spec.filename, spec.filename);
  }

  const helperSpecs = [
    { os: 'win', arch: 'x64', relativePath: 'computer-use-helper/win32-x64/open-computer-use.exe', assetFilename: 'open-computer-use-win32-x64.exe' },
    { os: 'mac', arch: 'universal', relativePath: 'computer-use-helper/darwin-universal/open-computer-use.app.zip', assetFilename: 'open-computer-use-darwin-universal.app.zip' },
    { os: 'linux', arch: 'x64', relativePath: 'computer-use-helper/linux-x64/open-computer-use', assetFilename: 'open-computer-use-linux-x64' },
  ];
  for (const spec of helperSpecs) {
    addStaticFileEntry(artifacts, absDir, absStageDir, { asset: 'computer-use-helper', ...spec });
  }

  const winWorkerManifest = readJsonIfRegular(join(absDir, 'remote-desktop-worker/win32-x64/imcodes-remote-desktop-worker.exe.manifest.json'));
  const winWorkerVersion = typeof winWorkerManifest?.workerVersion === 'string' ? winWorkerManifest.workerVersion : undefined;
  const linuxWorkerManifest = readJsonIfRegular(join(absDir, 'remote-desktop-worker/linux-x64/imcodes-remote-desktop-worker.manifest.json'));
  const linuxWorkerVersion = typeof linuxWorkerManifest?.workerVersion === 'string' ? linuxWorkerManifest.workerVersion : undefined;

  const sidecarSpecs = [
    { asset: 'remote-desktop-worker', os: 'win', arch: 'x64', relativePath: 'remote-desktop-worker/win32-x64/imcodes-remote-desktop-worker.exe', assetFilename: 'imcodes-remote-desktop-worker-win32-x64.exe', version: winWorkerVersion },
    { asset: 'remote-desktop-worker-manifest', os: 'win', arch: 'x64', relativePath: 'remote-desktop-worker/win32-x64/imcodes-remote-desktop-worker.exe.manifest.json', assetFilename: 'imcodes-remote-desktop-worker-win32-x64.exe.manifest.json', version: winWorkerVersion },
    { asset: 'remote-desktop-virtual-display', os: 'win', arch: 'x64', relativePath: 'remote-desktop-worker/win32-x64/imcodes-virtual-display.zip', assetFilename: 'imcodes-virtual-display-win32-x64.zip', version: winWorkerVersion },
    { asset: 'remote-desktop-worker', os: 'linux', arch: 'x64', relativePath: 'remote-desktop-worker/linux-x64/imcodes-remote-desktop-worker', assetFilename: 'imcodes-remote-desktop-worker-linux-x64', version: linuxWorkerVersion },
    { asset: 'remote-desktop-worker-manifest', os: 'linux', arch: 'x64', relativePath: 'remote-desktop-worker/linux-x64/imcodes-remote-desktop-worker.manifest.json', assetFilename: 'imcodes-remote-desktop-worker-linux-x64.manifest.json', version: linuxWorkerVersion },
    { asset: 'aidesk-local-ui', os: 'win', arch: 'x64', relativePath: 'aidesk-local-ui/win32-x64/aidesk-local-ui.exe', assetFilename: 'aidesk-local-ui-win32-x64.exe' },
    { asset: 'aidesk-local-ui-manifest', os: 'win', arch: 'x64', relativePath: 'aidesk-local-ui/win32-x64/aidesk-local-ui.manifest.json', assetFilename: 'aidesk-local-ui-win32-x64.manifest.json' },
    { asset: 'aidesk-local-ui-notices', os: 'win', arch: 'x64', relativePath: 'aidesk-local-ui/win32-x64/THIRD-PARTY-NOTICES.txt', assetFilename: 'aidesk-local-ui-win32-x64-THIRD-PARTY-NOTICES.txt' },
  ];
  for (const spec of sidecarSpecs) {
    addStaticFileEntry(artifacts, absDir, absStageDir, spec);
  }

  const expectedVersion = typeof version === 'string' && version.trim() ? version.trim() : undefined;
  const targetReleaseManifests = [];

  for (const rt of RUNTIME_TARGETS) {
    let daemonRuntimeEntry = null;
    const manifestRel = `daemon-runtime/daemon-runtime-${rt.target}.manifest.json`;
    const rtManifest = readJsonIfRegular(join(absDir, manifestRel));
    if (rtManifest && typeof rtManifest.artifact?.fileName === 'string' && typeof rtManifest.build?.version === 'string') {
      const rtVersion = rtManifest.build.version.trim();
      const signer = typeof rtManifest.artifact.authenticodeSignerSha256 === 'string'
        ? rtManifest.artifact.authenticodeSignerSha256.toLowerCase()
        : undefined;
      addStaticFileEntry(artifacts, absDir, absStageDir, {
        asset: 'daemon-runtime-manifest',
        os: rt.os,
        arch: rt.arch,
        relativePath: manifestRel,
        assetFilename: basename(manifestRel),
        version: rtVersion,
        ...(signer ? { authenticodeSignerSha256: signer } : {}),
      });
      const archiveName = basename(rtManifest.artifact.fileName);
      const archiveRel = `daemon-runtime/${archiveName}`;
      daemonRuntimeEntry = addStaticFileEntry(artifacts, absDir, absStageDir, {
        asset: 'daemon-runtime',
        os: rt.os,
        arch: rt.arch,
        relativePath: archiveRel,
        assetFilename: archiveName,
        version: rtVersion,
        ...(signer ? { authenticodeSignerSha256: signer } : {}),
      });
      if (!daemonRuntimeEntry) {
        throw new Error(`missing_daemon_runtime_archive:${archiveRel}`);
      }
      if (typeof rtManifest.artifact.sha256 === 'string'
        && rtManifest.artifact.sha256.toLowerCase() !== daemonRuntimeEntry.sha256) {
        throw new Error(`daemon_runtime_manifest_sha256_mismatch:${archiveRel}`);
      }
      if (typeof rtManifest.artifact.size === 'number'
        && rtManifest.artifact.size !== daemonRuntimeEntry.sizeBytes) {
        throw new Error(`daemon_runtime_manifest_size_mismatch:${archiveRel}`);
      }
    }

    const targetReleaseManifestRel = `desktop-release-${rt.target}.manifest.json`;
    const targetReleaseAbs = join(absDir, targetReleaseManifestRel);
    const targetReleaseJson = readJsonIfRegular(targetReleaseAbs);
    if (existsSync(targetReleaseAbs) && !targetReleaseJson) {
      throw new Error(`invalid_desktop_release_manifest:${targetReleaseManifestRel}`);
    }
    let targetBundle = null;
    if (targetReleaseJson) {
      if (targetReleaseJson.schemaVersion !== 1
        || typeof targetReleaseJson.releaseVersion !== 'string'
        || !targetReleaseJson.releaseVersion.trim()
        || typeof targetReleaseJson.gitSha !== 'string'
        || !GIT_SHA_RE.test(targetReleaseJson.gitSha.trim())) {
        throw new Error(`invalid_desktop_release_manifest:${targetReleaseManifestRel}`);
      }
      const relVer = targetReleaseJson.releaseVersion.trim();
      if (expectedVersion && relVer !== expectedVersion) {
        throw new Error(`desktop_release_manifest_version_mismatch:${rt.target}:${relVer}:${expectedVersion}`);
      }
      targetBundle = targetReleaseJson.targets?.[rt.target];
      if (!targetBundle || typeof targetBundle !== 'object' || Array.isArray(targetBundle)) {
        throw new Error(`desktop_release_manifest_missing_target:${rt.target}`);
      }
      const drComponent = targetBundle.components?.['daemon-runtime'];
      if (drComponent && daemonRuntimeEntry) {
        if (typeof drComponent.sha256 === 'string'
          && drComponent.sha256.toLowerCase() !== daemonRuntimeEntry.sha256) {
          throw new Error(`desktop_release_component_sha256_mismatch:${rt.target}:daemon-runtime`);
        }
        if (typeof drComponent.sizeBytes === 'number' && drComponent.sizeBytes !== daemonRuntimeEntry.sizeBytes) {
          throw new Error(`desktop_release_component_size_mismatch:${rt.target}:daemon-runtime`);
        }
      }
      if (!detectedVersion) detectedVersion = relVer;
      targetReleaseManifests.push({ target: rt.target, json: targetReleaseJson });
      addStaticFileEntry(artifacts, absDir, absStageDir, {
        asset: 'desktop-release-manifest',
        os: rt.os,
        arch: rt.arch,
        relativePath: targetReleaseManifestRel,
        assetFilename: targetReleaseManifestRel,
        version: relVer,
      });
    }

    const verifyInstallerSidecar = (relPath, entry, explicitSidecarRel) => {
      const sidecarCandidates = [
        ...(explicitSidecarRel ? [explicitSidecarRel] : []),
        `${relPath}.manifest.json`,
      ];
      for (const candidateRel of sidecarCandidates) {
        if (!isSafeRelativeAssetPath(candidateRel)) {
          throw new Error(`invalid_installer_sidecar_path:${candidateRel}`);
        }
        const sidecarJson = readJsonIfRegular(join(absDir, candidateRel));
        if (!sidecarJson) continue;
        if (typeof sidecarJson.artifact?.sha256 === 'string'
          && sidecarJson.artifact.sha256.toLowerCase() !== entry.sha256) {
          throw new Error(`desktop_installer_sidecar_sha256_mismatch:${relPath}`);
        }
        if (typeof sidecarJson.artifact?.size === 'number'
          && sidecarJson.artifact.size !== entry.sizeBytes) {
          throw new Error(`desktop_installer_sidecar_size_mismatch:${relPath}`);
        }
        break;
      }
    };

    const seenInstallerPaths = new Set();
    if (Array.isArray(targetBundle?.installers)) {
      for (const inst of targetBundle.installers) {
        if (!inst || typeof inst !== 'object' || Array.isArray(inst) || typeof inst.kind !== 'string' || !inst.kind) {
          throw new Error(`invalid_desktop_installer_entry:${rt.target}`);
        }
        const relPath = String(inst.relativePath ?? `installers/${inst.fileName ?? ''}`).replace(/\\/gu, '/');
        if (!isSafeRelativeAssetPath(relPath)) {
          throw new Error(`invalid_desktop_installer_path:${relPath}`);
        }
        const instVersion = typeof inst.version === 'string' && inst.version.trim()
          ? inst.version.trim()
          : targetReleaseJson.releaseVersion.trim();
        const entry = addStaticFileEntry(artifacts, absDir, absStageDir, {
          asset: `desktop-installer-${inst.kind}`,
          os: rt.os,
          arch: rt.arch,
          relativePath: relPath,
          assetFilename: basename(relPath),
          version: instVersion,
        });
        if (!entry) {
          throw new Error(`missing_desktop_installer:${relPath}`);
        }
        if (typeof inst.sha256 !== 'string' || !SHA256_RE.test(inst.sha256) || inst.sha256.toLowerCase() !== entry.sha256) {
          throw new Error(`desktop_installer_sha256_mismatch:${relPath}`);
        }
        if (typeof inst.sizeBytes !== 'number' || inst.sizeBytes !== entry.sizeBytes) {
          throw new Error(`desktop_installer_size_mismatch:${relPath}`);
        }
        const explicitSidecarRel = typeof inst.manifestFileName === 'string' && inst.manifestFileName
          ? `installers/${basename(inst.manifestFileName)}`
          : undefined;
        verifyInstallerSidecar(relPath, entry, explicitSidecarRel);
        seenInstallerPaths.add(relPath);
      }
    }

    const fallbackInstVersion = targetReleaseJson?.releaseVersion?.trim() || detectedVersion;
    for (const spec of canonicalInstallerSpecs(rt.target, rt.os, fallbackInstVersion)) {
      if (seenInstallerPaths.has(spec.relativePath)) continue;
      const entry = addStaticFileEntry(artifacts, absDir, absStageDir, {
        asset: `desktop-installer-${spec.kind}`,
        os: rt.os,
        arch: rt.arch,
        relativePath: spec.relativePath,
        assetFilename: basename(spec.relativePath),
        version: fallbackInstVersion,
      });
      if (entry) {
        verifyInstallerSidecar(spec.relativePath, entry);
      }
    }
  }

  const globalReleaseAbs = join(absDir, 'desktop-release.manifest.json');
  let globalReleaseJson = readJsonIfRegular(globalReleaseAbs);
  if (existsSync(globalReleaseAbs) && !globalReleaseJson) {
    throw new Error('invalid_desktop_release_manifest:desktop-release.manifest.json');
  }
  if (!globalReleaseJson && targetReleaseManifests.length > 0) {
    globalReleaseJson = mergeTargetReleaseManifests(targetReleaseManifests);
    writeFileSync(globalReleaseAbs, `${JSON.stringify(globalReleaseJson, null, 2)}\n`, 'utf8');
  } else if (globalReleaseJson && targetReleaseManifests.length > 0) {
    const firstTarget = targetReleaseManifests[0].json;
    if (typeof globalReleaseJson.releaseVersion !== 'string'
      || globalReleaseJson.releaseVersion.trim() !== firstTarget.releaseVersion.trim()) {
      throw new Error('desktop_release_manifest_version_mismatch:global');
    }
    if (typeof globalReleaseJson.gitSha !== 'string'
      || globalReleaseJson.gitSha.trim().toLowerCase() !== firstTarget.gitSha.trim().toLowerCase()) {
      throw new Error('desktop_release_manifest_git_sha_mismatch:global');
    }
  }
  if (globalReleaseJson && typeof globalReleaseJson.releaseVersion === 'string') {
    const globalVer = globalReleaseJson.releaseVersion.trim();
    if (expectedVersion && globalVer !== expectedVersion) {
      throw new Error(`desktop_release_manifest_version_mismatch:global:${globalVer}:${expectedVersion}`);
    }
    if (!detectedVersion) detectedVersion = globalVer;
    addStaticFileEntry(artifacts, absDir, absStageDir, {
      asset: 'desktop-release-manifest',
      relativePath: 'desktop-release.manifest.json',
      assetFilename: 'desktop-release.manifest.json',
      version: globalVer,
    });
  }

  const manifest = {
    schemaVersion: RELEASE_ARTIFACTS_MANIFEST_SCHEMA_VERSION,
    ...(detectedVersion ? { version: detectedVersion } : {}),
    generatedAt: new Date().toISOString(),
    artifacts,
  };
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  const targetOut = outputPath ? resolve(outputPath) : join(absDir, RELEASE_ARTIFACTS_MANIFEST_FILENAME);
  writeFileSync(targetOut, serialized, 'utf8');
  if (absStageDir) {
    mkdirSync(absStageDir, { recursive: true });
    writeFileSync(join(absStageDir, RELEASE_ARTIFACTS_MANIFEST_FILENAME), serialized, 'utf8');
  }
  return { manifest, outputPath: targetOut };
}

function parseArgs(argv) {
  const opts = { artifactsDir: '', version: undefined, stageDir: undefined, outputPath: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--version' && argv[i + 1]) opts.version = argv[++i];
    else if (arg === '--stage-dir' && argv[i + 1]) opts.stageDir = argv[++i];
    else if (arg === '--output' && argv[i + 1]) opts.outputPath = argv[++i];
    else if (!arg.startsWith('-') && !opts.artifactsDir) opts.artifactsDir = arg;
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.artifactsDir) {
    console.error('Usage: node scripts/generate-controlled-node-manifest.mjs <artifactsDir> [--version <ver>] [--stage-dir <dir>] [--output <path>]');
    process.exit(1);
  }
  const result = generateControlledNodeReleaseManifest(opts);
  console.log(`Generated ${result.outputPath} (${Object.keys(result.manifest.artifacts).length} artifacts)`);
}
