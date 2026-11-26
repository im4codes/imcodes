import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
// @ts-expect-error Plain ESM helper under scripts/
import {
  DAEMON_RUNTIME_FILES_FILENAME,
  WINDOWS_ZIP_SCRIPT_PATH,
  buildWindowsZipPowerShellArgs,
  collectBundleFileEntries,
  createArchiveFromDir,
  createDaemonRuntimeFilesDocument,
  createDaemonRuntimeManifest,
  extractArchiveToDir,
  parseDaemonRuntimeTarget,
  pruneStagedNodeModulesForTarget,
  removeDirForceSync,
  resolvePlatformCommand,
  sanitizeBundleRelativePath,
  shouldKeepPackageLockEntry,
  verifyDaemonRuntimeArchive,
  verifyExtractedDaemonRuntime,
  writeDaemonRuntimeJson,
} from '../../scripts/daemon-runtime-artifacts.mjs';
// @ts-expect-error Plain ESM helper under scripts/
import { sh as buildDaemonRuntimeSh } from '../../scripts/build-daemon-runtime.mjs';
// @ts-expect-error Plain ESM helper under scripts/
import { runSmokeCommand } from '../../scripts/run-preview-dist-smoke.mjs';

const tempDirs: string[] = [];

function tempDir(prefix = 'imcodes-dr-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? ((crc >>> 1) ^ 0xedb88320) : (crc >>> 1);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildDosStoredZip(entries: Array<{ name: string; data?: Buffer; externalAttr: number }>): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = entry.data ?? Buffer.alloc(0);
    const sum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8
    local.writeUInt16LE(0, 8); // method 0 = stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x5421, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localChunks.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0014, 4); // version made by: 0 (MS-DOS/FAT), spec 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); // UTF-8
    central.writeUInt16LE(0, 10); // method 0 = stored
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x5421, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(entry.externalAttr >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralDir = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralDir, eocd]);
}

function createFakeBundle(root: string, os: 'linux' | 'darwin' | 'win32' = 'linux') {
  const nodeRel = os === 'win32' ? 'node.exe' : 'bin/node';
  const files: Record<string, { content: string; mode?: number }> = {
    [nodeRel]: { content: '#!/bin/sh\necho v24.16.0\n', mode: 0o755 },
    'package/package.json': { content: '{"name":"imcodes","version":"0.1.2","type":"module"}\n' },
    'package/config/default.yaml': { content: 'daemon:\n  pollInterval: 1000\n' },
    'package/dist/src/index.js': { content: 'console.log("index");\n' },
    'package/dist/src/cli.js': { content: 'export function runCli() {}\n' },
    'package/dist/src/daemon/memory-mcp-bootstrap.js': { content: 'export {};\n' },
    'package/dist/src/context/embedding-worker-bootstrap.mjs': { content: 'export {};\n' },
    'package/dist/src/store/context-store-worker-bootstrap.mjs': { content: 'export {};\n' },
    'package/node_modules/sharp/package.json': { content: '{"name":"sharp"}\n' },
  };
  for (const [rel, spec] of Object.entries(files)) {
    const abs = join(root, ...rel.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, spec.content, { mode: spec.mode ?? 0o644 });
    if (spec.mode !== undefined && process.platform !== 'win32') {
      chmodSync(abs, spec.mode);
    }
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('daemon-runtime target & path validation', () => {
  it('parses supported platform/arch triples and rejects invalid ones', () => {
    expect(parseDaemonRuntimeTarget('linux-x64')).toMatchObject({
      os: 'linux',
      arch: 'x64',
      archiveFormat: 'tar.gz',
      nodeRelativePath: 'bin/node',
    });
    expect(parseDaemonRuntimeTarget('darwin', 'arm64')).toMatchObject({
      target: 'darwin-arm64',
      archiveFormat: 'tar.gz',
      nodeRelativePath: 'bin/node',
    });
    expect(parseDaemonRuntimeTarget('win32-x64')).toMatchObject({
      target: 'win32-x64',
      isWindows: true,
      archiveFormat: 'zip',
      nodeRelativePath: 'node.exe',
    });
    expect(() => parseDaemonRuntimeTarget('freebsd-x64')).toThrow(/unsupported/);
    expect(() => parseDaemonRuntimeTarget('win32-arm64')).toThrow(/unsupported/);
  });

  it('rejects path traversal and unsafe relative paths', () => {
    expect(sanitizeBundleRelativePath('package/dist/src/index.js')).toBe('package/dist/src/index.js');
    for (const unsafe of ['', '/abs', 'a/../b', '../escape', 'a\\b', 'C:foo', 'dir/', 'bad\0byte', 'line\nbreak']) {
      expect(() => sanitizeBundleRelativePath(unsafe)).toThrow();
    }
  });
});

describe('package-lock filtering and node_modules pruning', () => {
  it('filters devDependencies, foreign os/cpu, musl variants, and non-target @img packages', () => {
    const linuxX64 = parseDaemonRuntimeTarget('linux-x64');
    expect(shouldKeepPackageLockEntry('node_modules/vitest', { dev: true }, linuxX64)).toBe(false);
    expect(shouldKeepPackageLockEntry('node_modules/esbuild', { devOptional: true }, linuxX64)).toBe(false);
    expect(shouldKeepPackageLockEntry('node_modules/pino', {}, linuxX64)).toBe(true);
    expect(shouldKeepPackageLockEntry('node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64', {
      optional: true, os: ['darwin'], cpu: ['arm64'],
    }, linuxX64)).toBe(false);
    expect(shouldKeepPackageLockEntry('node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl', {
      optional: true, os: ['linux'], cpu: ['x64'],
    }, linuxX64)).toBe(false);
    expect(shouldKeepPackageLockEntry('node_modules/@anthropic-ai/claude-agent-sdk-linux-x64', {
      optional: true, os: ['linux'], cpu: ['x64'],
    }, linuxX64)).toBe(true);
    expect(shouldKeepPackageLockEntry('node_modules/@github/copilot-linuxmusl-x64', {
      optional: true, os: ['linux'], cpu: ['x64'],
    }, linuxX64)).toBe(false);
    expect(shouldKeepPackageLockEntry('node_modules/@img/colour', {}, linuxX64)).toBe(true);
    expect(shouldKeepPackageLockEntry('node_modules/@img/sharp-linux-x64', {
      optional: true, os: ['linux'], cpu: ['x64'],
    }, linuxX64)).toBe(true);
    expect(shouldKeepPackageLockEntry('node_modules/@img/sharp-linuxmusl-x64', {
      optional: true, os: ['linux'], cpu: ['x64'],
    }, linuxX64)).toBe(false);
    expect(shouldKeepPackageLockEntry('node_modules/@img/sharp-darwin-arm64', {
      optional: true, os: ['darwin'], cpu: ['arm64'],
    }, linuxX64)).toBe(false);
  });

  it('prunes foreign prebuilds, onnxruntime GPU EPs, .wasm, and keeps DirectML.dll + sharp', () => {
    const nmLinux = join(tempDir(), 'nm-linux');
    const write = (rel: string, content = 'x') => {
      const abs = join(nmLinux, ...rel.split('/'));
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, content);
    };

    write('.bin/vitest', 'bin');
    write('@huggingface/transformers/.cache/model.onnx', 'cache');
    write('@huggingface/transformers/node_modules/@img/colour/index.js');
    write('@huggingface/transformers/node_modules/@img/sharp-linux-x64/sharp.node');
    write('@huggingface/transformers/node_modules/@img/sharp-linuxmusl-x64/sharp.node');
    write('@img/colour/index.js');
    write('@img/sharp-linux-x64/sharp.node');
    write('@img/sharp-darwin-arm64/sharp.node');
    write('sharp/lib/index.js');
    write('onnxruntime-node/bin/napi-v3/linux/x64/onnxruntime_binding.node');
    write('onnxruntime-node/bin/napi-v3/linux/x64/libonnxruntime_providers_cuda.so');
    write('onnxruntime-node/bin/napi-v3/linux/x64/libonnxruntime_providers_tensorrt.so');
    write('onnxruntime-node/bin/napi-v3/darwin/arm64/libonnxruntime.dylib');
    write('onnxruntime-node/script/install-metadata.js', "export default { 'linux/x64': ['cuda12'] };");
    write('onnxruntime-node/package.json', JSON.stringify({ name: 'onnxruntime-node', scripts: { postinstall: 'node download' } }));
    write('onnxruntime-web/dist/ort.min.js');
    write('onnxruntime-web/dist/ort-wasm.wasm');
    write('onnxruntime-web/dist/ort.min.js.map');
    write('onnxruntime-web/dist/ort.all.min.js');
    write('node-pty/prebuilds/linux-x64/pty.node');
    write('node-pty/prebuilds/darwin-arm64/pty.node');
    write('node-pty/build/Release/pty.node');

    pruneStagedNodeModulesForTarget(nmLinux, parseDaemonRuntimeTarget('linux-x64'), {
      hostOs: 'linux',
      hostArch: 'x64',
    });

    expect(existsSync(join(nmLinux, '.bin'))).toBe(false);
    expect(existsSync(join(nmLinux, '@huggingface/transformers/.cache'))).toBe(false);
    expect(existsSync(join(nmLinux, 'sharp/lib/index.js'))).toBe(true);
    expect(existsSync(join(nmLinux, '@img/sharp-linux-x64/sharp.node'))).toBe(true);
    expect(existsSync(join(nmLinux, '@img/sharp-darwin-arm64'))).toBe(false);
    expect(existsSync(join(nmLinux, '@huggingface/transformers/node_modules/@img/sharp-linuxmusl-x64'))).toBe(false);
    expect(existsSync(join(nmLinux, 'onnxruntime-node/bin/napi-v3/linux/x64/onnxruntime_binding.node'))).toBe(true);
    expect(existsSync(join(nmLinux, 'onnxruntime-node/bin/napi-v3/linux/x64/libonnxruntime_providers_cuda.so'))).toBe(false);
    expect(existsSync(join(nmLinux, 'onnxruntime-node/bin/napi-v3/darwin'))).toBe(false);
    expect(readFileSync(join(nmLinux, 'onnxruntime-node/script/install-metadata.js'), 'utf8')).toContain("'linux/x64': []");
    expect(existsSync(join(nmLinux, 'onnxruntime-web/dist/ort.min.js'))).toBe(true);
    expect(existsSync(join(nmLinux, 'onnxruntime-web/dist/ort-wasm.wasm'))).toBe(false);
    expect(existsSync(join(nmLinux, 'onnxruntime-web/dist/ort.all.min.js'))).toBe(false);
    expect(existsSync(join(nmLinux, 'node-pty/prebuilds/darwin-arm64'))).toBe(false);
    expect(existsSync(join(nmLinux, 'node-pty/prebuilds/linux-x64/pty.node'))).toBe(true);

    // Windows preserves DirectML.dll while stripping dxcompiler.dll / dxil.dll.
    const nmWin = join(tempDir(), 'nm-win');
    const writeWin = (rel: string) => {
      const abs = join(nmWin, ...rel.split('/'));
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, 'dll');
    };
    writeWin('onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime.dll');
    writeWin('onnxruntime-node/bin/napi-v3/win32/x64/DirectML.dll');
    writeWin('onnxruntime-node/bin/napi-v3/win32/x64/dxcompiler.dll');
    writeWin('onnxruntime-node/bin/napi-v3/win32/x64/dxil.dll');
    pruneStagedNodeModulesForTarget(nmWin, parseDaemonRuntimeTarget('win32-x64'), {
      hostOs: 'win32',
      hostArch: 'x64',
    });
    expect(existsSync(join(nmWin, 'onnxruntime-node/bin/napi-v3/win32/x64/DirectML.dll'))).toBe(true);
    expect(existsSync(join(nmWin, 'onnxruntime-node/bin/napi-v3/win32/x64/dxcompiler.dll'))).toBe(false);
    expect(existsSync(join(nmWin, 'onnxruntime-node/bin/napi-v3/win32/x64/dxil.dll'))).toBe(false);
  });
});

describe('manifest generation and verification', () => {
  it('creates and verifies tar.gz archive + extracted files, rejecting tampering & symlinks', async () => {
    const work = tempDir();
    const bundleRoot = join(work, 'bundle');
    const outDir = join(work, 'out');
    mkdirSync(bundleRoot, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    createFakeBundle(bundleRoot, 'linux');

    const baseOpts = {
      bundleRoot,
      os: 'linux',
      arch: 'x64',
      nodeVersion: 'v24.16.0',
      nodeProvider: 'official-node',
      nodeArchive: 'node-v24.16.0-linux-x64.tar.gz',
      nodeArchiveSha256: 'a'.repeat(64),
      buildCommit: 'b'.repeat(40),
      buildVersion: '0.1.2',
    };
    const filesDoc = await createDaemonRuntimeFilesDocument(baseOpts);
    await writeDaemonRuntimeJson(join(bundleRoot, DAEMON_RUNTIME_FILES_FILENAME), filesDoc);

    const archivePath = join(outDir, 'daemon-runtime-linux-x64.tar.gz');
    execFileSync('tar', ['-czf', archivePath, '-C', bundleRoot, 'bin', 'package', DAEMON_RUNTIME_FILES_FILENAME]);

    const { manifest } = await createDaemonRuntimeManifest({ ...baseOpts, archivePath });
    const manifestPath = join(outDir, 'daemon-runtime-linux-x64.manifest.json');
    await writeDaemonRuntimeJson(manifestPath, manifest);

    const verified = await verifyDaemonRuntimeArchive(manifestPath, { expectedVersion: '0.1.2' });
    expect(verified.fileCount).toBe(filesDoc.fileCount);

    // Symlink inside extracted directory must fail.
    const linked = join(bundleRoot, 'package', 'evil-link');
    symlinkSync('/etc/passwd', linked);
    await expect(collectBundleFileEntries(bundleRoot)).rejects.toThrow(/symbolic link/);
    rmSync(linked, { force: true });

    // Tampering with extracted file fails verification.
    const indexPath = join(bundleRoot, 'package/dist/src/index.js');
    writeFileSync(indexPath, 'tampered');
    await expect(verifyExtractedDaemonRuntime(bundleRoot, manifest.files)).rejects.toThrow(/checksum mismatch|size mismatch/);

    // Restoring and adding an unexpected file fails verification.
    writeFileSync(indexPath, 'console.log("index");\n');
    const extraPath = join(bundleRoot, 'package/extra.js');
    writeFileSync(extraPath, 'extra');
    await expect(verifyExtractedDaemonRuntime(bundleRoot, manifest.files)).rejects.toThrow(/unexpected untracked file/);
    rmSync(extraPath);

    // Removing executable bit fails verification on POSIX.
    if (process.platform !== 'win32') {
      chmodSync(join(bundleRoot, 'bin/node'), 0o644);
      await expect(verifyExtractedDaemonRuntime(bundleRoot, manifest.files)).rejects.toThrow(/executable bit/);
      chmodSync(join(bundleRoot, 'bin/node'), 0o755);
    }

    // Tampering with archive fails archive checksum check.
    writeFileSync(archivePath, Buffer.concat([readFileSync(archivePath), Buffer.from('0')]));
    await expect(verifyDaemonRuntimeArchive(manifestPath)).rejects.toThrow(/size mismatch|checksum mismatch/);
  });

  it('enforces official-node provenance by default and rejects tampered manifest path traversal', async () => {
    const work = tempDir();
    const bundleRoot = join(work, 'bundle');
    const outDir = join(work, 'out');
    mkdirSync(bundleRoot, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    createFakeBundle(bundleRoot, 'linux');

    const localOpts = {
      bundleRoot,
      os: 'linux',
      arch: 'x64',
      nodeVersion: 'v24.16.0',
      nodeProvider: 'local-node-bin',
      nodeBinarySha256: sha256('local-node'),
      buildCommit: 'c'.repeat(40),
      buildVersion: '0.1.2',
    };
    const filesDoc = await createDaemonRuntimeFilesDocument(localOpts);
    await writeDaemonRuntimeJson(join(bundleRoot, DAEMON_RUNTIME_FILES_FILENAME), filesDoc);
    const archivePath = join(outDir, 'daemon-runtime-linux-x64.tar.gz');
    execFileSync('tar', ['-czf', archivePath, '-C', bundleRoot, 'bin', 'package', DAEMON_RUNTIME_FILES_FILENAME]);
    const { manifest } = await createDaemonRuntimeManifest({ ...localOpts, archivePath });
    const manifestPath = join(outDir, 'daemon-runtime-linux-x64.manifest.json');
    await writeDaemonRuntimeJson(manifestPath, manifest);

    await expect(verifyDaemonRuntimeArchive(manifestPath)).rejects.toThrow(/non-official nodeProvider/);
    await expect(verifyDaemonRuntimeArchive(manifestPath, { requireOfficialNode: false })).resolves.toBeTruthy();

    manifest.files[0].path = '../outside';
    await writeDaemonRuntimeJson(manifestPath, manifest);
    await expect(verifyDaemonRuntimeArchive(manifestPath, { requireOfficialNode: false })).rejects.toThrow(/invalid segment/);
  });
});

describe('daemon-runtime CI wiring and macOS entitlements', () => {
  it('wires daemon-runtime build, verification, smoke test, and archive upload into build-node-exe.yml and ci.yml', () => {
    for (const spec of [
      {
        file: '.github/workflows/build-node-exe.yml',
        uploadName: 'Upload executable artifact',
      },
      {
        file: '.github/workflows/ci.yml',
        uploadName: 'Upload controlled-node executable',
      },
    ]) {
      const workflow = readFileSync(spec.file, 'utf8');
      expect(workflow, spec.file).toContain('scripts/build-daemon-runtime.mjs');
      expect(workflow, spec.file).toContain('scripts/daemon-runtime-artifacts.mjs verify');
      expect(workflow, spec.file).toContain('dist-node-exe/daemon-runtime/**');
      expect(workflow, spec.file).toContain('chmod -R a-w "$SMOKE_ROOT"');
      expect(workflow, spec.file).toContain('Build, verify and smoke-test Windows daemon-runtime bundle');
      expect(workflow, spec.file).toContain('daemon-runtime-win32-x64.zip');
      const winStart = workflow.indexOf('Build, verify and smoke-test Windows daemon-runtime bundle');
      const winEnd = workflow.indexOf('\n      - name:', winStart);
      const winStep = workflow.slice(winStart, winEnd);
      expect(winStep, spec.file).toContain('--stage-dir');
      expect(winStep, spec.file).toContain('--keep-staging');
      expect(winStep, spec.file).toContain('daemon-runtime-stage');
      expect(winStep, spec.file).toContain('--archive-only');
      expect(winStep, spec.file).toContain('windows-zip-archive.ps1');
      expect(winStep, spec.file).not.toContain('Expand-Archive');
      const winInstStart = workflow.indexOf('Build, sign, and smoke-test Windows Inno Setup (.iss/.exe) installer');
      expect(winInstStart, spec.file).toBeGreaterThan(-1);
      const winInstEnd = workflow.indexOf('\n      - name:', winInstStart);
      const winInstStep = workflow.slice(winInstStart, winInstEnd === -1 ? undefined : winInstEnd);
      expect(winInstStep, spec.file).toContain('--runtime-dir');
      expect(winInstStep, spec.file).toContain('daemon-runtime-stage');
      expect(winInstStep, spec.file).not.toContain('--runtime-archive');
      expect(winInstStep, spec.file).toContain('finally');
      expect(winInstStep, spec.file).toContain('Remove-Item -LiteralPath $stageRoot');
      const buildStep = workflow.indexOf('Build, verify and smoke-test POSIX daemon-runtime bundle');
      const uploadStep = workflow.indexOf(spec.uploadName);
      const cleanupStep = workflow.indexOf('Remove macOS release-signing material');
      expect(buildStep, spec.file).toBeGreaterThan(-1);
      expect(buildStep, spec.file).toBeLessThan(uploadStep);
      expect(buildStep, spec.file).toBeLessThan(cleanupStep);
    }

    const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(ciWorkflow).toContain('Verify daemon-runtime bundles for every desktop target');
    expect(ciWorkflow).toContain('server/controlled-node-artifacts/daemon-runtime/daemon-runtime-${target}.manifest.json');
  });

  it('ships valid daemon-runtime macOS entitlements without XML comments', () => {
    const entitlements = readFileSync('native/macos-node/daemon-runtime.entitlements', 'utf8');
    expect(entitlements).toContain('com.apple.security.cs.allow-jit');
    expect(entitlements).toContain('com.apple.security.cs.allow-unsigned-executable-memory');
    expect(entitlements).toContain('com.apple.security.cs.disable-library-validation');
    expect(entitlements).not.toContain('<!--');
  });

  it('executes the extracted POSIX smoke prelude in isolated bash without mkdtemp typos and cleans up via EXIT trap', () => {
    const workflow = parseYaml(readFileSync('.github/workflows/build-node-exe.yml', 'utf8')) as {
      jobs: { build: { steps: Array<{ name?: string; run?: string }> } };
    };
    const posixStep = workflow.jobs.build.steps.find(
      (step) => step.name === 'Build, verify and smoke-test POSIX daemon-runtime bundle',
    );
    expect(posixStep?.run).toBeTruthy();
    const lines = String(posixStep!.run).split('\n').map((line) => line.trimEnd());
    const startIdx = lines.findIndex((line) => line.includes('SMOKE_ROOT=""'));
    const trapIdx = lines.findIndex((line) => line.includes('trap '));
    const homeMktempIdx = lines.findIndex((line) => line.includes('HOME_ROOT="$(mktemp -d'));
    expect(startIdx).toBeGreaterThan(-1);
    expect(trapIdx).toBeGreaterThan(startIdx);
    expect(homeMktempIdx).toBeGreaterThan(trapIdx);
    const prelude = lines.slice(startIdx, homeMktempIdx + 1).join('\n');
    expect(prelude).not.toContain('mkdtemp');

    const runnerTemp = tempDir('imcodes-posix-prelude-');
    const stdout = execFileSync(
      'bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        `set -euo pipefail\n${prelude}\ntest -d "$SMOKE_ROOT"\ntest -d "$HOME_ROOT"\nprintf '%s|%s\\n' "$SMOKE_ROOT" "$HOME_ROOT"`,
      ],
      {
        env: { ...process.env, RUNNER_TEMP: runnerTemp },
        encoding: 'utf8',
      },
    ).trim();

    const [createdSmoke, createdHome] = stdout.split('|');
    expect(createdSmoke.startsWith(runnerTemp)).toBe(true);
    expect(createdHome.startsWith(runnerTemp)).toBe(true);
    expect(createdSmoke).not.toBe(createdHome);
    expect(readdirSync(runnerTemp)).toEqual([]);

    // Partial-allocation failure: fail after SMOKE_ROOT is created, verify EXIT trap cleans up.
    const partialLines = lines.slice(startIdx, homeMktempIdx).join('\n');
    let failed = false;
    try {
      execFileSync(
        'bash',
        ['--noprofile', '--norc', '-c', `set -euo pipefail\n${partialLines}\nfalse`],
        { env: { ...process.env, RUNNER_TEMP: runnerTemp }, stdio: 'pipe' },
      );
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(readdirSync(runnerTemp)).toEqual([]);
  });
});

describe('Windows zip PowerShell -File invocation without -Command/$args', () => {
  it('eliminates powershell -Command and $args across runtime build/verify scripts', () => {
    const buildSrc = readFileSync('scripts/build-daemon-runtime.mjs', 'utf8');
    const artifactsSrc = readFileSync('scripts/daemon-runtime-artifacts.mjs', 'utf8');
    const ps1Src = readFileSync('scripts/windows-zip-archive.ps1', 'utf8');

    expect(buildSrc).not.toMatch(/['"]-Command['"]/);
    expect(buildSrc).not.toMatch(/\$args\[\d+\]/);
    expect(artifactsSrc).not.toMatch(/['"]-Command['"]/);
    expect(artifactsSrc).not.toMatch(/\$args\[\d+\]/);
    expect(ps1Src).toContain("ValidateSet('Expand', 'Compress')");
    expect(ps1Src).toContain("$ProgressPreference = 'SilentlyContinue'");
    expect(ps1Src).not.toContain('Expand-Archive');
    expect(ps1Src).not.toContain('Compress-Archive');
    expect(ps1Src).toContain('Resolve-SevenZipExecutable');
    expect(ps1Src).toContain('IMCODES_WINDOWS_7Z_PATH');
    expect(ps1Src).toContain('-mmt=on');
    expect(ps1Src).toContain('[System.IO.Compression.ZipFile]::ExtractToDirectory');
    expect(ps1Src).toContain('[System.IO.Compression.ZipFile]::OpenRead');
    expect(ps1Src).toContain('[System.IO.Compression.ZipFile]::Open');
    expect(ps1Src).toContain('[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile');
    expect(ps1Src).toContain('[System.IO.Compression.CompressionLevel]::Fastest');
    expect(ps1Src).toContain('Zip entry escapes destination directory');
    expect(ps1Src).toContain(".Replace('\\', '/')");
    expect(buildSrc).toContain('filesDocument: preFilesDoc');
  });

  it('reuses precomputed filesDocument in createDaemonRuntimeManifest and rejects mismatched metadata', async () => {
    const work = tempDir('imcodes-dr-precomputed-');
    const bundleRoot = join(work, 'bundle');
    const outDir = join(work, 'out');
    mkdirSync(bundleRoot, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    createFakeBundle(bundleRoot, 'win32');
    for (let i = 0; i < 40; i += 1) {
      const sub = join(bundleRoot, 'package', 'node_modules', `pkg-${i}`);
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, 'index.js'), `export const n = ${i};\n`);
    }

    const localOpts = {
      bundleRoot,
      os: 'win32',
      arch: 'x64',
      nodeVersion: 'v24.16.0',
      nodeProvider: 'local-node-bin',
      nodeBinarySha256: sha256('local-node'),
      buildCommit: 'f'.repeat(40),
      buildVersion: '0.1.5',
    };
    const preFilesDoc = await createDaemonRuntimeFilesDocument(localOpts);
    await writeDaemonRuntimeJson(join(bundleRoot, DAEMON_RUNTIME_FILES_FILENAME), preFilesDoc);

    const archivePath = join(outDir, 'daemon-runtime-win32-x64.zip');
    createArchiveFromDir(bundleRoot, archivePath, 'zip');

    const { manifest } = await createDaemonRuntimeManifest({
      ...localOpts,
      archivePath,
      filesDocument: preFilesDoc,
    });
    expect(manifest.fileCount).toBe(preFilesDoc.fileCount);
    expect(manifest.files).toEqual(preFilesDoc.files);

    const manifestPath = join(outDir, 'daemon-runtime-win32-x64.manifest.json');
    await writeDaemonRuntimeJson(manifestPath, manifest);
    const verified = await verifyDaemonRuntimeArchive(manifestPath, { requireOfficialNode: false });
    expect(verified.fileCount).toBe(preFilesDoc.fileCount);

    await expect(
      createDaemonRuntimeManifest({
        ...localOpts,
        buildVersion: '0.1.6',
        archivePath,
        filesDocument: preFilesDoc,
      }),
    ).rejects.toThrow(/precomputed filesDocument metadata does not match/);
  });

  it.runIf(process.platform === 'win32')(
    'round-trips win32 zip via both 7z and .NET ZipFile fallback (IMCODES_WINDOWS_7Z_PATH=none) including spaces, $, quotes, empty dirs, and overwrite',
    async () => {
      const root = tempDir('imcodes-dr-winzip-');
      const bundleRoot = join(root, "stage 'win' $pkg");
      const outDir = join(root, "out 'win' $dir");
      mkdirSync(join(bundleRoot, 'package', 'empty-sub'), { recursive: true });
      mkdirSync(outDir, { recursive: true });
      createFakeBundle(bundleRoot, 'win32');

      const localOpts = {
        bundleRoot,
        os: 'win32',
        arch: 'x64',
        nodeVersion: 'v24.16.0',
        nodeProvider: 'local-node-bin',
        nodeBinarySha256: sha256('local-node'),
        buildCommit: '1'.repeat(40),
        buildVersion: '0.1.6',
      };
      const filesDoc = await createDaemonRuntimeFilesDocument(localOpts);
      await writeDaemonRuntimeJson(join(bundleRoot, DAEMON_RUNTIME_FILES_FILENAME), filesDoc);

      for (const modeEnv of [{}, { IMCODES_WINDOWS_7Z_PATH: 'none' }]) {
        const archivePath = join(outDir, 'daemon-runtime-win32-x64.zip');
        const psExe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        execFileSync(
          psExe,
          buildWindowsZipPowerShellArgs('Compress', bundleRoot, archivePath, { platform: 'win32' }),
          { env: { ...process.env, ...modeEnv }, stdio: 'pipe' },
        );

        const { manifest } = await createDaemonRuntimeManifest({ ...localOpts, archivePath });
        const manifestPath = join(outDir, 'daemon-runtime-win32-x64.manifest.json');
        await writeDaemonRuntimeJson(manifestPath, manifest);
        const verified = await verifyDaemonRuntimeArchive(manifestPath, { requireOfficialNode: false });
        expect(verified.fileCount).toBe(manifest.fileCount);

        // Extract into both empty and pre-populated (with read-only file) destinations.
        const destEmpty = join(root, "dest empty 'win' $1");
        const destExisting = join(root, "dest existing 'win' $2");
        mkdirSync(destExisting, { recursive: true });
        const roTarget = join(destExisting, 'node.exe');
        writeFileSync(roTarget, 'old-readonly');
        chmodSync(roTarget, 0o444);

        for (const dest of [destEmpty, destExisting]) {
          execFileSync(
            psExe,
            buildWindowsZipPowerShellArgs('Expand', archivePath, dest, { platform: 'win32' }),
            { env: { ...process.env, ...modeEnv }, stdio: 'pipe' },
          );
          expect(existsSync(join(dest, 'package', 'empty-sub'))).toBe(true);
          await verifyExtractedDaemonRuntime(dest, manifest.files, { checkExecutableBit: false });
        }
        removeDirForceSync(destEmpty);
        removeDirForceSync(destExisting);
      }
    },
  );

  it('passes literal -File script arguments with spaces and single quotes under win32', () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mockExec = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
    };
    const stagePath = "C:\\Work Space\\stage 'one'\\$node";
    const archivePath = "C:\\Out 'Dir'\\daemon runtime 'win32'.zip";
    const extractPath = "C:\\Verify 'Dir'\\out put";
    const env = { SystemRoot: "C:\\Win 'Root'" };

    const builtArgs = buildWindowsZipPowerShellArgs('Compress', stagePath, archivePath, { platform: 'win32' });
    expect(builtArgs).not.toContain('-Command');
    expect(builtArgs).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      WINDOWS_ZIP_SCRIPT_PATH,
      '-Mode',
      'Compress',
      '-SourcePath',
      stagePath,
      '-DestinationPath',
      archivePath,
    ]);

    createArchiveFromDir(stagePath, archivePath, 'zip', {
      platform: 'win32',
      env,
      execFileSyncImpl: mockExec,
    });
    extractArchiveToDir(archivePath, 'zip', extractPath, {
      platform: 'win32',
      env,
      execFileSyncImpl: mockExec,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].cmd).toBe("C:\\Win 'Root'\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(calls[0].args[calls[0].args.indexOf('-Mode') + 1]).toBe('Compress');
    expect(calls[0].args[calls[0].args.indexOf('-SourcePath') + 1]).toBe(stagePath);
    expect(calls[0].args[calls[0].args.indexOf('-DestinationPath') + 1]).toBe(archivePath);
    expect(calls[1].cmd).toBe("C:\\Win 'Root'\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(calls[1].args[calls[1].args.indexOf('-Mode') + 1]).toBe('Expand');
    expect(calls[1].args[calls[1].args.indexOf('-SourcePath') + 1]).toBe(archivePath);
    expect(calls[1].args[calls[1].args.indexOf('-DestinationPath') + 1]).toBe(extractPath);
  });

  it('round-trips a real zip bundle whose stage and archive paths contain spaces and single quotes', async () => {
    const root = tempDir('imcodes-dr-zip-');
    const bundleRoot = join(root, "stage with spaces and 'quotes'");
    const outDir = join(root, "out with spaces and 'quotes'");
    mkdirSync(outDir, { recursive: true });
    createFakeBundle(bundleRoot, 'win32');
    const localOpts = {
      bundleRoot,
      os: 'win32',
      arch: 'x64',
      nodeVersion: 'v24.16.0',
      nodeProvider: 'local-node-bin',
      nodeBinarySha256: sha256('local-node'),
      buildCommit: 'd'.repeat(40),
      buildVersion: '0.1.3',
    };
    const filesDoc = await createDaemonRuntimeFilesDocument(localOpts);
    await writeDaemonRuntimeJson(join(bundleRoot, DAEMON_RUNTIME_FILES_FILENAME), filesDoc);
    const archivePath = join(outDir, "daemon-runtime-win32 'test'.zip");
    createArchiveFromDir(bundleRoot, archivePath, 'zip');
    const { manifest } = await createDaemonRuntimeManifest({ ...localOpts, archivePath });
    const manifestPath = join(outDir, "daemon-runtime-win32 'test'.manifest.json");
    await writeDaemonRuntimeJson(manifestPath, manifest);

    const verified = await verifyDaemonRuntimeArchive(manifestPath, { requireOfficialNode: false });
    expect(verified.artifact.format).toBe('zip');
    expect(verified.fileCount).toBe(manifest.fileCount);
  });

  it('removeDirForceSync cleans read-only directories safely without following symlinks and is idempotent', () => {
    const missing = join(tempDir(), 'never-existed');
    expect(() => removeDirForceSync(missing)).not.toThrow();

    if (process.platform === 'win32') return;

    const root = tempDir('imcodes-dr-ro-cleanup-');
    const targetDir = join(root, 'target');
    const roSub = join(targetDir, 'ro-sub');
    const lockedSub = join(targetDir, 'locked-sub');
    const externalDir = join(root, 'external-dir');
    const externalFile = join(externalDir, 'keep.txt');

    mkdirSync(roSub, { recursive: true });
    mkdirSync(lockedSub, { recursive: true });
    mkdirSync(externalDir, { recursive: true });
    writeFileSync(join(roSub, 'ro.txt'), 'readonly');
    writeFileSync(join(lockedSub, 'inner.txt'), 'locked');
    writeFileSync(externalFile, 'do-not-touch');

    chmodSync(join(roSub, 'ro.txt'), 0o444);
    chmodSync(externalFile, 0o444);
    symlinkSync(externalDir, join(roSub, 'link-dir'));
    symlinkSync(externalFile, join(roSub, 'link-file'));
    chmodSync(roSub, 0o555);
    chmodSync(lockedSub, 0o000);
    chmodSync(externalDir, 0o555);

    try {
      if (process.platform === 'linux') {
        expect(() => rmSync(targetDir, { recursive: true, force: true })).toThrow(/EACCES|EPERM|ENOTEMPTY/);
      }

      removeDirForceSync(targetDir);
      expect(existsSync(targetDir)).toBe(false);
      expect(existsSync(externalDir)).toBe(true);
      expect(existsSync(externalFile)).toBe(true);
      expect(statSync(externalDir).mode & 0o777).toBe(0o555);
      expect(statSync(externalFile).mode & 0o777).toBe(0o444);
    } finally {
      chmodSync(externalDir, 0o755);
      chmodSync(externalFile, 0o644);
    }
  });

  it('verifies a win32-x64 .zip containing DOS read-only directories (0x11) and leaves zero temp verify dirs', async () => {
    if (process.platform === 'win32') return;

    const root = tempDir('imcodes-dr-dos0x11-');
    const bundleRoot = join(root, 'bundle');
    const outDir = join(root, 'out');
    mkdirSync(outDir, { recursive: true });
    createFakeBundle(bundleRoot, 'win32');

    const localOpts = {
      bundleRoot,
      os: 'win32',
      arch: 'x64',
      nodeVersion: 'v24.16.0',
      nodeProvider: 'local-node-bin',
      nodeBinarySha256: sha256('local-node'),
      buildCommit: 'e'.repeat(40),
      buildVersion: '0.1.4',
    };
    const filesDoc = await createDaemonRuntimeFilesDocument(localOpts);
    await writeDaemonRuntimeJson(join(bundleRoot, DAEMON_RUNTIME_FILES_FILENAME), filesDoc);

    // Build a real .zip where every directory entry carries DOS FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_READONLY (0x11)
    // and files carry FILE_ATTRIBUTE_READONLY (0x01), which Linux `unzip` extracts as mode 0o555 / 0o444.
    const allEntries = await collectBundleFileEntries(bundleRoot, 'win32');
    const dirSet = new Set<string>();
    for (const file of allEntries) {
      const parts = file.path.split('/');
      for (let i = 1; i < parts.length; i += 1) {
        dirSet.add(`${parts.slice(0, i).join('/')}/`);
      }
    }
    const zipEntries = [
      ...[...dirSet].sort().map((dirName) => ({ name: dirName, externalAttr: 0x11 })),
      ...allEntries.map((file) => ({
        name: file.path,
        data: readFileSync(join(bundleRoot, ...file.path.split('/'))),
        externalAttr: 0x01,
      })),
    ];

    const archivePath = join(outDir, 'daemon-runtime-win32-x64.zip');
    writeFileSync(archivePath, buildDosStoredZip(zipEntries));

    // Confirm raw `unzip -q` extracts 0o555 directory under Linux/macOS and raw `rmSync` would fail on Linux.
    const probeExtract = join(root, 'probe-unzip');
    mkdirSync(probeExtract, { recursive: true });
    execFileSync('unzip', ['-q', archivePath, '-d', probeExtract], { stdio: 'pipe' });
    expect(statSync(join(probeExtract, 'package', 'node_modules')).mode & 0o777).toBe(0o555);
    if (process.platform === 'linux') {
      expect(() => rmSync(probeExtract, { recursive: true, force: true })).toThrow(/EACCES|EPERM|ENOTEMPTY/);
    }
    removeDirForceSync(probeExtract);
    expect(existsSync(probeExtract)).toBe(false);

    const { manifest } = await createDaemonRuntimeManifest({ ...localOpts, archivePath });
    const manifestPath = join(outDir, 'daemon-runtime-win32-x64.manifest.json');
    await writeDaemonRuntimeJson(manifestPath, manifest);

    const beforeVerifyDirs = new Set(
      readdirSync(tmpdir()).filter((name) => name.startsWith('imcodes-daemon-runtime-verify-')),
    );
    const verified = await verifyDaemonRuntimeArchive(manifestPath, { requireOfficialNode: false });
    const afterVerifyDirs = readdirSync(tmpdir()).filter((name) => name.startsWith('imcodes-daemon-runtime-verify-'));
    const leaked = afterVerifyDirs.filter((name) => !beforeVerifyDirs.has(name));

    expect(verified.artifact.os).toBe('win32');
    expect(verified.fileCount).toBe(manifest.fileCount);
    expect(leaked).toEqual([]);
  });
});

describe('Windows .cmd/.bat command invocation resolution', () => {
  it('routes npm/npx and .cmd/.bat through ComSpec cmd.exe /d /s /c on win32 without shell:true', () => {
    const winNpm = resolvePlatformCommand('npm', ['run', 'build'], {
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    });
    expect(winNpm).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '"npm.cmd run build"'],
      options: { windowsVerbatimArguments: true },
    });

    const winNpxSpaces = resolvePlatformCommand('C:\\Program Files\\nodejs\\npx.cmd', ['vitest', 'run', 'my file.ts'], {
      platform: 'win32',
      env: {},
    });
    expect(winNpxSpaces).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', '"\"C:\\Program Files\\nodejs\\npx.cmd\" vitest run \"my file.ts\""'],
      options: { windowsVerbatimArguments: true },
    });

    expect(resolvePlatformCommand('git', ['rev-parse', 'HEAD'], { platform: 'win32', env: {} })).toEqual({
      command: 'git',
      args: ['rev-parse', 'HEAD'],
      options: {},
    });

    expect(resolvePlatformCommand('npm', ['run', 'build'], { platform: 'linux', env: {} })).toEqual({
      command: 'npm',
      args: ['run', 'build'],
      options: {},
    });

    expect(() => resolvePlatformCommand('npm', ['run\nwhoami'], { platform: 'win32', env: {} })).toThrow(/forbidden control/i);
    expect(() => resolvePlatformCommand('npm', ['bad"arg'], { platform: 'win32', env: {} })).toThrow(/double quotes/i);
  });

  it('invokes build-daemon-runtime and preview-smoke commands via cmd.exe on simulated win32 without shell:true or EINVAL', () => {
    const execCalls: Array<{ file: string; args: string[]; opts: Record<string, unknown> }> = [];
    buildDaemonRuntimeSh('npm', ['run', 'build'], {
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      cwd: 'C:\\repo',
      execFileSyncImpl: (file: string, args: string[], opts: Record<string, unknown>) => {
        execCalls.push({ file, args, opts });
        return '';
      },
    });
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(execCalls[0].args).toEqual(['/d', '/s', '/c', '"npm.cmd run build"']);
    expect(execCalls[0].opts.windowsVerbatimArguments).toBe(true);
    expect(execCalls[0].opts.shell).toBeUndefined();
    expect(execCalls[0].opts.cwd).toBe('C:\\repo');

    const spawnCalls: Array<{ file: string; args: string[]; opts: Record<string, unknown> }> = [];
    runSmokeCommand('npx', ['vitest', 'run'], {
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      spawnSyncImpl: (file: string, args: string[], opts: Record<string, unknown>) => {
        spawnCalls.push({ file, args, opts });
        return { status: 0 };
      },
    });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(spawnCalls[0].args).toEqual(['/d', '/s', '/c', '"npx.cmd vitest run"']);
    expect(spawnCalls[0].opts.windowsVerbatimArguments).toBe(true);
    expect(spawnCalls[0].opts.shell).toBe(false);
  });
});
