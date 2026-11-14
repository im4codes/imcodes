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
  sanitizeBundleRelativePath,
  shouldKeepPackageLockEntry,
  verifyDaemonRuntimeArchive,
  verifyExtractedDaemonRuntime,
  writeDaemonRuntimeJson,
} from '../../scripts/daemon-runtime-artifacts.mjs';

const tempDirs: string[] = [];

function tempDir(prefix = 'imcodes-dr-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
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
    expect(ps1Src).toContain('Expand-Archive -LiteralPath $SourcePath -DestinationPath $DestinationPath -Force');
    expect(ps1Src).toContain('Compress-Archive -LiteralPath ($Items | ForEach-Object { $_.FullName }) -DestinationPath $DestinationPath -CompressionLevel Optimal -Force');
  });

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
});
