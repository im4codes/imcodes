import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error ESM script module
import {
  BUNDLED_TMUX_REQUIRED_ARCHS,
  BUNDLED_TMUX_REQUIRED_TERMS,
  BUNDLED_TMUX_SOURCES,
  parseBuildBundledTmuxArgs,
  runTerminfoSessionGate,
  validateBundledTmuxLayout,
  validateLipoArchsOutput,
  validateOtoolDependencies,
  verifyBundledTmux,
  verifyTarballSha256,
} from '../../scripts/build-macos-bundled-tmux.mjs';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'imcodes-tmux-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createValidStagedFixture(root: string, options: { hexTerminfo?: boolean } = {}): string {
  const binDir = join(root, 'bin');
  const terminfoDir = join(root, 'terminfo');
  const licensesDir = join(root, 'licenses');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(licensesDir, { recursive: true });

  const tmuxBin = join(binDir, 'tmux');
  writeFileSync(tmuxBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  for (const term of BUNDLED_TMUX_REQUIRED_TERMS) {
    const sub = options.hexTerminfo === false
      ? term[0]
      : term.charCodeAt(0).toString(16).padStart(2, '0');
    mkdirSync(join(terminfoDir, sub), { recursive: true });
    writeFileSync(join(terminfoDir, sub, term), Buffer.from([0x1a, 0x01, 0x00, 0x00]));
  }

  for (const pkg of Object.values(BUNDLED_TMUX_SOURCES) as Array<{ licenseOutFilename: string }>) {
    writeFileSync(join(licensesDir, pkg.licenseOutFilename), `${pkg.licenseOutFilename}\n`, 'utf8');
  }
  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('build-macos-bundled-tmux manifest and verification gates', () => {
  it('pins upstream libevent, ncurses, and tmux sources with valid SHA-256 checksums and licenses', () => {
    expect(Object.keys(BUNDLED_TMUX_SOURCES).sort()).toEqual(['libevent', 'ncurses', 'tmux']);
    for (const pkg of Object.values(BUNDLED_TMUX_SOURCES) as Array<{
      sha256: string;
      urls: readonly string[];
      licenseOutFilename: string;
    }>) {
      expect(pkg.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(pkg.urls.length).toBeGreaterThan(0);
      expect(pkg.licenseOutFilename).toMatch(/\.txt$/);
    }

    const dir = makeTempDir();
    const tarball = join(dir, 'sample.tar.gz');
    const payload = Buffer.from('deterministic-source-tarball');
    writeFileSync(tarball, payload);
    const expected = createHash('sha256').update(payload).digest('hex');

    expect(verifyTarballSha256(tarball, expected)).toBe(expected);
    expect(() => verifyTarballSha256(tarball, '0'.repeat(64), 'sample.tar.gz')).toThrow(
      /SHA-256 mismatch/,
    );
  });

  it('Gate 1: accepts universal arm64 + x86_64 lipo output and rejects single-arch or empty output', () => {
    expect(validateLipoArchsOutput('x86_64 arm64\n')).toEqual(['x86_64', 'arm64']);
    expect(validateLipoArchsOutput('arm64 x86_64')).toEqual(['arm64', 'x86_64']);

    expect(() => validateLipoArchsOutput('arm64\n')).toThrow(/Gate 1 \(arch\) failed.*x86_64/);
    expect(() => validateLipoArchsOutput('x86_64\n')).toThrow(/Gate 1 \(arch\) failed.*arm64/);
    expect(() => validateLipoArchsOutput('')).toThrow(/Gate 1 \(arch\) failed/);
  });

  it('Gate 2: enforces strict /usr/lib/ and /System/Library/ allowlist and rejects @rpath, Homebrew, /usr/local, Nix, and traversal', () => {
    const validOtool = [
      '/tmp/out/bin/tmux (architecture arm64):',
      '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)',
      '\t/usr/lib/libresolv.9.dylib (compatibility version 1.0.0, current version 1.0.0)',
      '\t/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0, current version 2503.1.0)',
    ].join('\n');
    expect(validateOtoolDependencies(validOtool, 'arm64')).toEqual([
      '/usr/lib/libSystem.B.dylib',
      '/usr/lib/libresolv.9.dylib',
      '/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation',
    ]);

    const badSamples = [
      '/opt/homebrew/opt/libevent/lib/libevent_core-2.1.7.dylib',
      '/usr/local/opt/ncurses/lib/libncursesw.6.dylib',
      '@rpath/libncursesw.6.dylib',
      '@loader_path/libevent.dylib',
      '@executable_path/../Frameworks/libevent.dylib',
      '/nix/store/abc-ncurses/lib/libncursesw.6.dylib',
      '/var/folders/tmp/build/lib/libevent.dylib',
      '/usr/lib/../opt/homebrew/lib/libevil.dylib',
    ];
    for (const badPath of badSamples) {
      const output = [
        '/tmp/out/bin/tmux:',
        '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)',
        `\t${badPath} (compatibility version 1.0.0, current version 1.0.0)`,
      ].join('\n');
      expect(() => validateOtoolDependencies(output, 'x86_64')).toThrow(/Gate 2 \(dylib allowlist, arch=x86_64\) failed/);
    }

    expect(() => validateOtoolDependencies('/tmp/out/bin/tmux:\n', 'arm64')).toThrow(/no dylib entries/);
  });

  it('validates staged layout for bin/tmux, compiled terminfo entries, and license texts', () => {
    const hexOut = createValidStagedFixture(makeTempDir());
    const layout = validateBundledTmuxLayout(hexOut);
    expect(layout.tmuxBin).toBe(join(hexOut, 'bin', 'tmux'));
    expect(Object.keys(layout.resolvedTerminfoEntries)).toEqual([...BUNDLED_TMUX_REQUIRED_TERMS]);
    expect(Object.keys(layout.resolvedLicenses).sort()).toEqual(['libevent', 'ncurses', 'tmux']);

    const charOut = createValidStagedFixture(makeTempDir(), { hexTerminfo: false });
    expect(validateBundledTmuxLayout(charOut).resolvedTerminfoEntries['tmux-256color']).toBe(
      join(charOut, 'terminfo', 't', 'tmux-256color'),
    );

    const missingTerminfo = createValidStagedFixture(makeTempDir());
    rmSync(join(missingTerminfo, 'terminfo', '74', 'tmux-256color'));
    expect(() => validateBundledTmuxLayout(missingTerminfo)).toThrow(/tmux-256color/);

    const missingLicense = createValidStagedFixture(makeTempDir());
    rmSync(join(missingLicense, 'licenses', 'tmux-ISC.txt'));
    expect(() => validateBundledTmuxLayout(missingLicense)).toThrow(/tmux-ISC\.txt/);

    const nonExecBin = createValidStagedFixture(makeTempDir());
    chmodSync(join(nonExecBin, 'bin', 'tmux'), 0o644);
    expect(() => validateBundledTmuxLayout(nonExecBin)).toThrow();
  });

  it('Gate 4 + verifyBundledTmux: checks per-arch otool allowlist and isolated/fallback terminfo sessions with cleanup', () => {
    const outDir = createValidStagedFixture(makeTempDir());
    const seenTerms: string[] = [];
    const seenModes: Array<string | undefined> = [];
    const createdTempRoots: string[] = [];

    const mockExec = vi.fn((cmd: string, args: string[], opts?: { env?: Record<string, string> }) => {
      if (cmd === '/usr/bin/lipo') {
        expect(args).toEqual(['-archs', join(outDir, 'bin', 'tmux')]);
        return 'x86_64 arm64\n';
      }
      if (cmd === '/usr/bin/otool') {
        expect(args[0]).toBe('-arch');
        expect(BUNDLED_TMUX_REQUIRED_ARCHS).toContain(args[1]);
        return `${join(outDir, 'bin', 'tmux')}:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)\n`;
      }
      if (cmd === join(outDir, 'bin', 'tmux')) {
        if (args.includes('new-session')) {
          seenTerms.push(opts?.env?.TERM ?? '');
          seenModes.push(opts?.env?.TERMINFO_DIRS);
          if (opts?.env?.TMUX_TMPDIR) createdTempRoots.push(opts.env.TMUX_TMPDIR);
        }
        return '';
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const report = verifyBundledTmux(outDir, { execFn: mockExec });
    expect(report.archs).toEqual(['x86_64', 'arm64']);
    expect(seenTerms).toEqual([
      ...BUNDLED_TMUX_REQUIRED_TERMS,
      ...BUNDLED_TMUX_REQUIRED_TERMS,
      ...BUNDLED_TMUX_REQUIRED_TERMS,
    ]);
    expect(seenModes).toContain(join(outDir, 'terminfo'));
    expect(seenModes).toContain(`${join(outDir, 'terminfo')}:/usr/share/terminfo`);
    expect(seenModes).toContain(undefined);
    for (const dir of createdTempRoots) {
      expect(existsSync(dir)).toBe(false);
    }

    // Per-arch Gate 2 catch: arm64 clean, x86_64 leaks /opt/homebrew -> fails Gate 2
    const archLeakExec = vi.fn((cmd: string, args: string[]) => {
      if (cmd === '/usr/bin/lipo') return 'arm64 x86_64\n';
      if (cmd === '/usr/bin/otool' && args[1] === 'arm64') {
        return `${join(outDir, 'bin', 'tmux')}:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)\n`;
      }
      if (cmd === '/usr/bin/otool' && args[1] === 'x86_64') {
        return `${join(outDir, 'bin', 'tmux')}:\n\t/opt/homebrew/lib/libevent.dylib (compatibility version 1.0.0, current version 1.0.0)\n`;
      }
      return '';
    });
    expect(() => verifyBundledTmux(outDir, { execFn: archLeakExec })).toThrow(
      /Gate 2 \(dylib allowlist, arch=x86_64\) failed/,
    );

    // Gate 4 failure catch: missing terminfo fails new-session -d and still cleans up temp dir
    const failingTempDirs: string[] = [];
    const gate4FailExec = vi.fn((cmd: string, args: string[], opts?: { env?: Record<string, string> }) => {
      if (cmd === join(outDir, 'bin', 'tmux') && args.includes('new-session')) {
        if (opts?.env?.TMUX_TMPDIR) failingTempDirs.push(opts.env.TMUX_TMPDIR);
        const err = new Error('open terminal failed: missing or unsuitable terminal: tmux-256color') as Error & {
          stderr?: string;
        };
        err.stderr = 'open terminal failed: missing or unsuitable terminal: tmux-256color';
        throw err;
      }
      return '';
    });
    expect(() => runTerminfoSessionGate(outDir, { execFn: gate4FailExec })).toThrow(
      /Gate 4 \(terminfo\) failed for TERM=screen/,
    );
    expect(failingTempDirs.length).toBe(1);
    expect(existsSync(failingTempDirs[0])).toBe(false);
  });

  it('parses CLI options for build and --verify-only modes', () => {
    const parsed = parseBuildBundledTmuxArgs([
      '--verify-only',
      '--out-dir',
      '/tmp/custom-tmux-out',
      '--src-cache',
      '/tmp/custom-src-cache',
      '--min-macos',
      '12.3',
    ]);
    expect(parsed.verifyOnly).toBe(true);
    expect(parsed.outDir).toContain('custom-tmux-out');
    expect(parsed.srcCacheDir).toContain('custom-src-cache');
    expect(parsed.minimumSystemVersion).toBe('12.3');
  });

  it('passes real Gate 1, Gate 2, and Gate 4 verification when dist-node-exe/bundled-tmux-macos is present on macOS', () => {
    const stagedDir = join(process.cwd(), 'dist-node-exe', 'bundled-tmux-macos');
    if (process.platform !== 'darwin' || !existsSync(join(stagedDir, 'bin', 'tmux'))) {
      return;
    }
    const report = verifyBundledTmux(stagedDir);
    expect(report.archs).toContain('arm64');
    expect(report.archs).toContain('x86_64');
    expect(report.terminfoGate.every((row: { passed: boolean }) => row.passed)).toBe(true);
    expect(readdirSync(join(stagedDir, 'licenses')).sort()).toEqual([
      'libevent-BSD-3-Clause.txt',
      'ncurses-MIT.txt',
      'tmux-ISC.txt',
    ]);
  });
});
