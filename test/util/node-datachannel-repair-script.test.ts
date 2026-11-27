import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isDirectInvocation, repairNodeDatachannel, resolveNpmCliJs } from '../../src/util/node-datachannel-repair.mjs';
import { buildBashNodeDatachannelRepair } from '../../src/util/node-datachannel-repair-script.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('buildBashNodeDatachannelRepair', () => {
  const block = buildBashNodeDatachannelRepair();

  it('verifies the native module by importing it from the installed package', () => {
    expect(block).toContain('node-datachannel-repair.mjs');
    expect(block).toContain('"$NODE" "$NODE_DATACHANNEL_REPAIR" "$IMCODES_PACKAGE_DIR"');
  });

  it('runs only the dependency lifecycle with scripts explicitly enabled and never installs into packageRoot', () => {
    const implementation = readFileSync(join(process.cwd(), 'src', 'util', 'node-datachannel-repair.mjs'), 'utf8');
    expect(implementation).toContain("'rebuild', '--global=false', '--prefix', packageRoot");
    expect(implementation).toContain("'node-datachannel', '--ignore-scripts=false', '--foreground-scripts'");
    expect(implementation).toContain("'install', '--global=false', '--prefix', stagingRoot");
    expect(implementation).toContain("'--no-save', '--no-audit', '--no-fund', '--ignore-scripts=false', '--foreground-scripts'");
    expect(implementation).not.toContain("'install', '--global=false', '--prefix', packageRoot");
    expect(block).not.toContain('install -g');
  });

  it('resolves npm-cli.js without routing dynamic paths through a command shell', () => {
    const root = mkdtempSync(join(tmpdir(), 'imcodes npm & repair-'));
    cleanup.push(root);
    const nodeDir = join(root, 'Node Runtime & Tools');
    const npmCommand = join(nodeDir, 'npm.cmd');
    const npmCli = join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const ambientNpmCli = join(root, 'Ambient npm & runtime', 'npm-cli.js');
    const arbitraryExecutable = join(root, 'Ambient npm & runtime', 'not-npm.js');
    mkdirSync(join(nodeDir, 'node_modules', 'npm', 'bin'), { recursive: true });
    mkdirSync(join(root, 'Ambient npm & runtime'), { recursive: true });
    writeFileSync(npmCommand, 'shim');
    writeFileSync(npmCli, 'cli');
    writeFileSync(ambientNpmCli, 'ambient cli');
    writeFileSync(arbitraryExecutable, 'not npm');

    expect(resolveNpmCliJs(npmCommand, join(nodeDir, 'node.exe'), {})).toBe(npmCli);
    expect(resolveNpmCliJs(npmCommand, join(nodeDir, 'node.exe'), {
      npm_execpath: ambientNpmCli,
    })).toBe(ambientNpmCli);
    for (const invalidNpmExecPath of [
      npmCommand,
      arbitraryExecutable,
      'relative/npm-cli.js',
      join(root, 'missing', 'npm-cli.js'),
    ]) {
      expect(resolveNpmCliJs(npmCommand, join(nodeDir, 'node.exe'), {
        npm_execpath: invalidNpmExecPath,
      })).toBe(npmCli);
    }
    const implementation = readFileSync(join(process.cwd(), 'src', 'util', 'node-datachannel-repair.mjs'), 'utf8');
    expect(implementation).toContain('shell: false');
    expect(implementation).not.toContain('shell: windowsCommandShim');
  });

  it.skipIf(process.platform === 'win32')('recognizes direct execution through a canonicalized path alias', () => {
    const root = mkdtempSync(join(tmpdir(), 'imcodes repair entry-'));
    cleanup.push(root);
    const realDir = join(root, 'real');
    const aliasDir = join(root, 'alias');
    mkdirSync(realDir);
    symlinkSync(realDir, aliasDir, 'dir');
    const realEntry = join(realDir, 'repair.mjs');
    const aliasEntry = join(aliasDir, 'repair.mjs');
    writeFileSync(realEntry, 'fixture');

    expect(isDirectInvocation(aliasEntry, realEntry)).toBe(true);
  });

  it('verifies again after rebuild and degrades to relay on failure', () => {
    const implementation = readFileSync(join(process.cwd(), 'src', 'util', 'node-datachannel-repair.mjs'), 'utf8');
    const rebuildIndex = implementation.indexOf("'rebuild', '--global=false', '--prefix', packageRoot");
    expect(implementation.indexOf('if (verify(packageRoot))', rebuildIndex)).toBeGreaterThan(rebuildIndex);
    expect(block).toContain('direct transfer unavailable; relay remains enabled');
    expect(block).not.toMatch(/\bexit\s+[1-9]/);
  });

  it('repairs a real script-suppressed dependency and verifies its native marker', () => {
    const root = mkdtempSync(join(tmpdir(), 'imcodes node-datachannel & repair-'));
    cleanup.push(root);
    const prefix = join(root, 'prefix');
    const imcodesDir = join(prefix, 'lib', 'node_modules', 'imcodes');
    const dependencyDir = join(imcodesDir, 'node_modules', 'node-datachannel');
    const marker = join(dependencyDir, 'build', 'Release', 'node_datachannel.node');
    mkdirSync(dependencyDir, { recursive: true });
    writeFileSync(join(imcodesDir, 'package.json'), JSON.stringify({
      name: 'imcodes',
      private: true,
      optionalDependencies: { 'node-datachannel': '0.0.0-test' },
    }));
    writeFileSync(join(dependencyDir, 'package.json'), JSON.stringify({
      name: 'node-datachannel',
      version: '0.0.0-test',
      type: 'module',
      main: 'index.js',
      scripts: { install: 'node install.cjs' },
    }));
    writeFileSync(join(dependencyDir, 'index.js'), [
      "import { existsSync } from 'node:fs';",
      "import { fileURLToPath } from 'node:url';",
      "import { dirname, join } from 'node:path';",
      "const here = dirname(fileURLToPath(import.meta.url));",
      "if (!existsSync(join(here, 'build', 'Release', 'node_datachannel.node'))) throw new Error('native addon missing');",
    ].join('\n'));
    writeFileSync(join(dependencyDir, 'install.cjs'), [
      "const { mkdirSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      "const out = join(__dirname, 'build', 'Release');",
      "mkdirSync(out, { recursive: true });",
      "writeFileSync(join(out, 'node_datachannel.node'), 'fixture');",
    ].join('\n'));
    const repairDistDir = join(imcodesDir, 'dist', 'src', 'util');
    mkdirSync(repairDistDir, { recursive: true });
    writeFileSync(
      join(repairDistDir, 'node-datachannel-repair.mjs'),
      readFileSync(join(process.cwd(), 'src', 'util', 'node-datachannel-repair.mjs'), 'utf8'),
    );
    const scriptPath = join(root, 'repair.sh');
    const logPath = join(root, 'repair.log');
    writeFileSync(scriptPath, [
      'set -u',
      `export npm_config_prefix=${JSON.stringify(prefix)}`,
      // A globally installed package can inherit global npm mode on some
      // platforms/configurations. The repair must still target this package's
      // own node_modules tree rather than the prefix-level global tree.
      'export npm_config_global=true',
      'NPM_RUN=npm',
      `NODE=${JSON.stringify(process.execPath)}`,
      `LOG=${JSON.stringify(logPath)}`,
      'log() { printf "%s\\n" "$1" >> "$LOG"; }',
      block,
    ].join('\n'));

    execFileSync('bash', [scriptPath], { stdio: 'pipe' });

    const repairLog = readFileSync(logPath, 'utf8');
    if (!existsSync(marker)) throw new Error(`native marker missing after repair:\n${repairLog}`);
    expect(readFileSync(marker, 'utf8')).toBe('fixture');
    expect(repairLog).toContain('node-datachannel repair succeeded');
  });
});

describe('node-datachannel optional dependency decoupling', () => {
  it('keeps direct-file-transfer-worker free of compile-time node-datachannel imports', () => {
    const workerSource = readFileSync(join(process.cwd(), 'src', 'daemon', 'direct-file-transfer-worker.ts'), 'utf8');
    expect(workerSource).not.toMatch(/import\(\s*['"]node-datachannel['"]\s*\)/);
    expect(workerSource).not.toMatch(/from\s+['"]node-datachannel['"]/);

    const tmpDir = mkdtempSync(join(tmpdir(), 'imcodes-missing-ndc-tsc-'));
    cleanup.push(tmpDir);
    const isolatedTsconfigPath = join(tmpDir, 'tsconfig.missing-ndc.json');
    const rootDir = process.cwd();
    writeFileSync(isolatedTsconfigPath, JSON.stringify({
      extends: join(rootDir, 'tsconfig.json'),
      compilerOptions: {
        paths: {
          'node-datachannel': [join(tmpDir, '__missing_optional_dep__')],
        },
      },
      include: [join(rootDir, 'src', 'daemon', 'direct-file-transfer-worker.ts')],
    }, null, 2));

    const tscBin = join(rootDir, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
    execFileSync(
      tscBin,
      ['-p', isolatedTsconfigPath, '--noEmit'],
      { cwd: rootDir, stdio: 'pipe', shell: process.platform === 'win32' },
    );
  });

  function resolveBashBin(): string | null {
    if (process.platform !== 'win32') return 'bash';
    for (const candidate of [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    ]) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  function setupIsolatedCiProject(options: {
    declareOptionalDep: boolean;
    ciInstallsDep: boolean;
    failInstallAttempts: number;
  }) {
    const parentDir = mkdtempSync(join(tmpdir(), 'imcodes-ci-ndc-parent-'));
    cleanup.push(parentDir);

    // Put a decoy package.json in parentDir to prove ci-npm-ci.sh passes the
    // project working directory explicitly rather than falling back to
    // DEFAULT_PACKAGE_ROOT (which resolves to parentDir when run from src/util).
    writeFileSync(join(parentDir, 'package.json'), JSON.stringify({
      name: 'decoy-parent',
      private: true,
      optionalDependencies: { 'node-datachannel': '^0.0.0-decoy' },
    }));

    const projectDir = join(parentDir, 'project with spaces');
    const binDir = join(parentDir, 'bin');
    const npmLogPath = join(parentDir, 'npm-calls.jsonl');
    const attemptCountPath = join(parentDir, 'install-attempts.txt');
    const fakeNpmJs = join(parentDir, 'fake-npm.cjs');
    const fakeNodeWrapper = join(binDir, 'node');
    const fakeNpmWrapper = join(binDir, 'npm');

    mkdirSync(join(projectDir, 'scripts'), { recursive: true });
    mkdirSync(join(projectDir, 'src', 'util'), { recursive: true });
    mkdirSync(binDir, { recursive: true });

    writeFileSync(
      join(projectDir, 'scripts', 'ci-npm-ci.sh'),
      readFileSync(join(process.cwd(), 'scripts', 'ci-npm-ci.sh'), 'utf8'),
    );
    chmodSync(join(projectDir, 'scripts', 'ci-npm-ci.sh'), 0o755);
    writeFileSync(
      join(projectDir, 'src', 'util', 'node-datachannel-repair.mjs'),
      readFileSync(join(process.cwd(), 'src', 'util', 'node-datachannel-repair.mjs'), 'utf8'),
    );
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
      name: 'isolated-ci-project',
      private: true,
      ...(options.declareOptionalDep
        ? { optionalDependencies: { 'node-datachannel': '^0.32.3' } }
        : {}),
    }));

    writeFileSync(fakeNpmJs, [
      "const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      "const args = process.argv.slice(2);",
      "const subcmd = args[0] || '';",
      "const logFile = process.env.TEST_NPM_LOG;",
      "appendFileSync(logFile, JSON.stringify({ subcmd, args, cwd: process.cwd() }) + '\\n');",
      "function writeWorkingDep(root) {",
      "  const depDir = join(root, 'node_modules', 'node-datachannel');",
      "  mkdirSync(depDir, { recursive: true });",
      "  writeFileSync(join(depDir, 'package.json'), JSON.stringify({ name: 'node-datachannel', version: '0.32.3', type: 'module', main: './index.js' }));",
      "  writeFileSync(join(depDir, 'index.js'), 'export default { ok: true };\\n');",
      "}",
      "if (subcmd === 'ci') {",
      `  if (${JSON.stringify(options.ciInstallsDep)}) writeWorkingDep(process.cwd());`,
      "  process.exit(0);",
      "}",
      "if (subcmd === 'install') {",
      "  const countFile = process.env.TEST_ATTEMPT_COUNT;",
      "  const prev = existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) : 0;",
      "  const cur = prev + 1;",
      "  writeFileSync(countFile, String(cur));",
      `  if (cur <= ${JSON.stringify(options.failInstallAttempts)}) process.exit(1);`,
      "  const prefixIdx = args.indexOf('--prefix');",
      "  const targetRoot = prefixIdx >= 0 ? args[prefixIdx + 1] : process.cwd();",
      "  writeWorkingDep(targetRoot);",
      "  process.exit(0);",
      "}",
      "process.exit(0);",
    ].join('\n'));

    writeFileSync(fakeNpmWrapper, `#!/usr/bin/env sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeNpmJs)} "$@"\n`);
    chmodSync(fakeNpmWrapper, 0o755);

    const nodeBinDir = dirname(process.execPath);
    // Ensure `node` inside bash resolves to process.execPath even in minimal environments.
    if (!existsSync(fakeNodeWrapper)) {
      writeFileSync(fakeNodeWrapper, `#!/usr/bin/env sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
      chmodSync(fakeNodeWrapper, 0o755);
    }

    const bashBin = resolveBashBin()!;
    const result = spawnSync(bashBin, [join(projectDir, 'scripts', 'ci-npm-ci.sh'), projectDir], {
      cwd: parentDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${nodeBinDir}${delimiter}${process.env.PATH ?? ''}`,
        CI_NPM_CI_MAX_ATTEMPTS: '1',
        IMCODES_NPM_CLI: fakeNpmJs,
        TEST_NPM_LOG: npmLogPath,
        TEST_ATTEMPT_COUNT: attemptCountPath,
      },
    });

    const calls = existsSync(npmLogPath)
      ? readFileSync(npmLogPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { subcmd: string; args: string[]; cwd: string })
      : [];

    return { parentDir, projectDir, result, calls };
  }

  const bashBin = resolveBashBin();

  it.skipIf(!bashBin)('repairs missing node-datachannel on attempt 1 via isolated staging without targeting projectDir and stops retrying', () => {
    const { parentDir, projectDir, result, calls } = setupIsolatedCiProject({
      declareOptionalDep: true,
      ciInstallsDep: false,
      failInstallAttempts: 0,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('WARNING: optional dependency node-datachannel is missing after npm ci');
    expect(result.stdout).toContain('node-datachannel repair succeeded on attempt 1');
    expect(calls.map((c) => c.subcmd)).toEqual(['ci', 'install']);
    const installCall = calls[1];
    expect(installCall.args).toContain('node-datachannel@^0.32.3');
    const installPrefix = installCall.args[installCall.args.indexOf('--prefix') + 1];
    expect(installPrefix).not.toBe(resolve(projectDir));
    expect(installCall.cwd).toBe(installPrefix);
    expect(existsSync(join(projectDir, 'node_modules', 'node-datachannel', 'package.json'))).toBe(true);
    expect(existsSync(join(parentDir, 'node_modules'))).toBe(false);
  });

  it('counterexample: failed isolated reinstall preserves sibling pino and existing node-datachannel without passing --prefix packageRoot', () => {
    const root = mkdtempSync(join(tmpdir(), 'imcodes ndc fail & pino-'));
    cleanup.push(root);
    const pkgRoot = join(root, 'pkg');
    const pinoDir = join(pkgRoot, 'node_modules', 'pino');
    const depDir = join(pkgRoot, 'node_modules', 'node-datachannel');
    const npmLogPath = join(root, 'npm-calls.jsonl');
    const fakeNpmJs = join(root, 'fake-npm.cjs');
    const fakeNpmWrapper = join(root, process.platform === 'win32' ? 'npm.cmd' : 'npm');

    mkdirSync(pinoDir, { recursive: true });
    mkdirSync(depDir, { recursive: true });
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({
      name: 'imcodes',
      private: true,
      optionalDependencies: { 'node-datachannel': '^0.32.3' },
    }));
    writeFileSync(join(pinoDir, 'package.json'), JSON.stringify({ name: 'pino', version: '9.0.0' }));
    writeFileSync(join(pinoDir, 'pino.js'), 'export default function pino() {}\n');
    writeFileSync(join(depDir, 'package.json'), JSON.stringify({
      name: 'node-datachannel', version: '0.32.3', type: 'module', main: './index.js',
    }));
    writeFileSync(join(depDir, 'index.js'), "throw new Error('preexisting broken addon');\n");
    writeFileSync(fakeNpmJs, [
      "const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      "const args = process.argv.slice(2);",
      `appendFileSync(${JSON.stringify(npmLogPath)}, JSON.stringify({ subcmd: args[0], args, cwd: process.cwd() }) + '\\n');`,
      "if (args[0] === 'rebuild') {",
      "  const depRoot = join(process.cwd(), 'node_modules', 'node-datachannel');",
      "  mkdirSync(join(depRoot, 'build'), { recursive: true });",
      "  writeFileSync(join(depRoot, 'index.js'), \"throw new Error('corrupted by failed rebuild');\\n\");",
      "  writeFileSync(join(depRoot, 'build', 'partial.o'), 'dirty');",
      "  process.exit(2);",
      "}",
      "if (args[0] === 'install') {",
      "  if (process.env.TEST_BROKEN_STAGING === '1') {",
      "    const prefix = args[args.indexOf('--prefix') + 1];",
      "    const staged = join(prefix, 'node_modules', 'node-datachannel');",
      "    mkdirSync(staged, { recursive: true });",
      "    writeFileSync(join(staged, 'package.json'), JSON.stringify({ name: 'node-datachannel', version: '0.32.3', type: 'module', main: './index.js' }));",
      "    writeFileSync(join(staged, 'index.js'), \"throw new Error('broken staging install');\\n\");",
      "    process.exit(0);",
      "  }",
      "  process.exit(217);",
      "}",
      "process.exit(0);",
    ].join('\n'));
    if (process.platform === 'win32') {
      writeFileSync(fakeNpmWrapper, `@echo off\r\n"${process.execPath}" "${fakeNpmJs}" %*\r\n`);
    } else {
      writeFileSync(fakeNpmWrapper, `#!/usr/bin/env sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeNpmJs)} "$@"\n`, { mode: 0o755 });
    }

    const result = repairNodeDatachannel({
      packageRoot: pkgRoot,
      npmCommand: fakeNpmWrapper,
      npmCli: fakeNpmJs,
    });

    expect(result).toEqual({ available: false, attempted: true, repaired: false, reason: 'verification_failed' });
    const calls = readFileSync(npmLogPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { subcmd: string; args: string[]; cwd: string });
    expect(calls.map((c) => c.subcmd)).toEqual(['rebuild', 'install']);
    const installCall = calls.find((c) => c.subcmd === 'install');
    expect(installCall).toBeDefined();
    expect(installCall!.args[installCall!.args.indexOf('--prefix') + 1]).not.toBe(resolve(pkgRoot));
    expect(installCall!.cwd).not.toBe(resolve(pkgRoot));
    // Sibling pino and pre-existing node-datachannel (restored after destructive rebuild) must be intact.
    expect(JSON.parse(readFileSync(join(pinoDir, 'package.json'), 'utf8'))).toEqual({ name: 'pino', version: '9.0.0' });
    expect(readFileSync(join(pinoDir, 'pino.js'), 'utf8')).toBe('export default function pino() {}\n');
    expect(readFileSync(join(depDir, 'index.js'), 'utf8')).toBe("throw new Error('preexisting broken addon');\n");
    expect(existsSync(join(depDir, 'build', 'partial.o'))).toBe(false);
    expect(readdirSync(join(pkgRoot, 'node_modules')).filter((name) => name.startsWith('.node-datachannel-'))).toEqual([]);

    // Same guarantee when isolated install exits 0 but fails staging verification.
    process.env.TEST_BROKEN_STAGING = '1';
    try {
      const stagingFailed = repairNodeDatachannel({
        packageRoot: pkgRoot,
        npmCommand: fakeNpmWrapper,
        npmCli: fakeNpmJs,
      });
      expect(stagingFailed).toEqual({ available: false, attempted: true, repaired: false, reason: 'verification_failed' });
      expect(readFileSync(join(depDir, 'index.js'), 'utf8')).toBe("throw new Error('preexisting broken addon');\n");
      expect(existsSync(join(depDir, 'build', 'partial.o'))).toBe(false);
      expect(readFileSync(join(pinoDir, 'pino.js'), 'utf8')).toBe('export default function pino() {}\n');
      expect(readdirSync(join(pkgRoot, 'node_modules')).filter((name) => name.startsWith('.node-datachannel-'))).toEqual([]);
    } finally {
      delete process.env.TEST_BROKEN_STAGING;
    }
  });

  it('installs in staging, rejects parent-level decoy unless staging itself works, then swaps only node-datachannel cleanly', () => {
    const root = mkdtempSync(join(tmpdir(), 'imcodes ndc swap & decoy-'));
    cleanup.push(root);
    // Parent node_modules decoy must NOT pass verification for either staging or pkgRoot.
    const decoyDir = join(root, 'node_modules', 'node-datachannel');
    mkdirSync(decoyDir, { recursive: true });
    writeFileSync(join(decoyDir, 'package.json'), JSON.stringify({
      name: 'node-datachannel', version: 'decoy', type: 'module', main: './index.js',
    }));
    writeFileSync(join(decoyDir, 'index.js'), 'export default { decoy: true };\n');

    const pkgRoot = join(root, 'imcodes & spaces');
    const pinoDir = join(pkgRoot, 'node_modules', 'pino');
    const npmLogPath = join(root, 'npm-calls.jsonl');
    const fakeNpmJs = join(root, 'fake-npm.cjs');
    const fakeNpmWrapper = join(root, process.platform === 'win32' ? 'npm.cmd' : 'npm');

    mkdirSync(pinoDir, { recursive: true });
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({
      name: 'imcodes',
      private: true,
      optionalDependencies: { 'node-datachannel': '^0.32.3' },
    }));
    writeFileSync(join(pinoDir, 'package.json'), JSON.stringify({ name: 'pino', version: '9.0.0' }));

    // Step 1: npm install exits 0 without creating node-datachannel in staging -> decoy must NOT fool verify(stagingRoot).
    writeFileSync(fakeNpmJs, [
      "const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      "const args = process.argv.slice(2);",
      `appendFileSync(${JSON.stringify(npmLogPath)}, JSON.stringify({ subcmd: args[0], args, cwd: process.cwd() }) + '\\n');`,
      "if (args[0] === 'install' && process.env.TEST_WRITE_STAGED === '1') {",
      "  const prefix = args[args.indexOf('--prefix') + 1];",
      "  const depDir = join(prefix, 'node_modules', 'node-datachannel');",
      "  mkdirSync(depDir, { recursive: true });",
      "  writeFileSync(join(depDir, 'package.json'), JSON.stringify({ name: 'node-datachannel', version: '0.32.3', type: 'module', main: './index.js' }));",
      "  writeFileSync(join(depDir, 'index.js'), 'export default { staged: true };\\n');",
      "}",
      "process.exit(0);",
    ].join('\n'));
    if (process.platform === 'win32') {
      writeFileSync(fakeNpmWrapper, `@echo off\r\n"${process.execPath}" "${fakeNpmJs}" %*\r\n`);
    } else {
      writeFileSync(fakeNpmWrapper, `#!/usr/bin/env sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeNpmJs)} "$@"\n`, { mode: 0o755 });
    }

    process.env.TEST_WRITE_STAGED = '0';
    try {
      const decoyOnly = repairNodeDatachannel({
        packageRoot: pkgRoot,
        npmCommand: fakeNpmWrapper,
        npmCli: fakeNpmJs,
      });
      expect(decoyOnly).toEqual({ available: false, attempted: true, repaired: false, reason: 'verification_failed' });
      expect(existsSync(join(pkgRoot, 'node_modules', 'node-datachannel'))).toBe(false);

      process.env.TEST_WRITE_STAGED = '1';
      const repaired = repairNodeDatachannel({
        packageRoot: pkgRoot,
        npmCommand: fakeNpmWrapper,
        npmCli: fakeNpmJs,
      });
      expect(repaired).toEqual({ available: true, attempted: true, repaired: true });
      expect(readFileSync(join(pkgRoot, 'node_modules', 'node-datachannel', 'index.js'), 'utf8')).toContain('staged: true');
      expect(JSON.parse(readFileSync(join(pinoDir, 'package.json'), 'utf8'))).toEqual({ name: 'pino', version: '9.0.0' });
      expect(readdirSync(join(pkgRoot, 'node_modules')).filter((name) => name.startsWith('.node-datachannel-'))).toEqual([]);
      const calls = readFileSync(npmLogPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { subcmd: string; args: string[]; cwd: string });
      for (const installCall of calls.filter((c) => c.subcmd === 'install')) {
        const stagedRoot = installCall.args[installCall.args.indexOf('--prefix') + 1];
        expect(existsSync(stagedRoot)).toBe(false);
      }
    } finally {
      delete process.env.TEST_WRITE_STAGED;
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('skips repair fast without spawning npm when node_modules is not writable', () => {
    const root = mkdtempSync(join(tmpdir(), 'imcodes ndc readonly-'));
    cleanup.push(root);
    const pkgRoot = join(root, 'pkg');
    const nodeModulesDir = join(pkgRoot, 'node_modules');
    const depDir = join(nodeModulesDir, 'node-datachannel');
    const npmLogPath = join(root, 'npm-calls.jsonl');
    const fakeNpmJs = join(root, 'fake-npm.cjs');
    const fakeNpmWrapper = join(root, 'npm');

    mkdirSync(depDir, { recursive: true });
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({
      name: 'imcodes',
      private: true,
      optionalDependencies: { 'node-datachannel': '^0.32.3' },
    }));
    writeFileSync(join(depDir, 'package.json'), JSON.stringify({
      name: 'node-datachannel', version: '0.32.3', type: 'module', main: './index.js',
    }));
    writeFileSync(join(depDir, 'index.js'), "throw new Error('broken');\n");
    writeFileSync(fakeNpmJs, `require('node:fs').appendFileSync(${JSON.stringify(npmLogPath)}, 'called\\n');\n`);
    writeFileSync(fakeNpmWrapper, `#!/usr/bin/env sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeNpmJs)} "$@"\n`, { mode: 0o755 });

    chmodSync(nodeModulesDir, 0o555);
    try {
      const logs: string[] = [];
      const result = repairNodeDatachannel({
        packageRoot: pkgRoot,
        npmCommand: fakeNpmWrapper,
        npmCli: fakeNpmJs,
        log: (line) => logs.push(line),
      });
      expect(result).toEqual({ available: false, attempted: false, repaired: false, reason: 'not_writable' });
      expect(existsSync(npmLogPath)).toBe(false);
      expect(logs.some((line) => line.includes('not writable'))).toBe(true);
      expect(readdirSync(nodeModulesDir).filter((name) => name.startsWith('.imcodes-write-probe'))).toEqual([]);
    } finally {
      chmodSync(nodeModulesDir, 0o755);
    }
  });

  it.skipIf(!bashBin)('retries once on first repair failure and succeeds on attempt 2', () => {
    const { projectDir, result, calls } = setupIsolatedCiProject({
      declareOptionalDep: true,
      ciInstallsDep: false,
      failInstallAttempts: 1,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('node-datachannel repair succeeded on attempt 2');
    expect(calls.map((c) => c.subcmd)).toEqual(['ci', 'install', 'install']);
    expect(existsSync(join(projectDir, 'node_modules', 'node-datachannel', 'package.json'))).toBe(true);
  });

  it.skipIf(!bashBin)('bounds failed repair to 2 attempts and exits 0 best-effort', () => {
    const { projectDir, result, calls } = setupIsolatedCiProject({
      declareOptionalDep: true,
      ciInstallsDep: false,
      failInstallAttempts: 5,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('node-datachannel repair succeeded');
    expect(calls.map((c) => c.subcmd)).toEqual(['ci', 'install', 'install']);
    expect(existsSync(join(projectDir, 'node_modules', 'node-datachannel', 'package.json'))).toBe(false);
  });

  it.skipIf(!bashBin)('skips repair when node-datachannel is already installed or not declared', () => {
    const installed = setupIsolatedCiProject({
      declareOptionalDep: true,
      ciInstallsDep: true,
      failInstallAttempts: 0,
    });
    expect(installed.result.status).toBe(0);
    expect(installed.calls.map((c) => c.subcmd)).toEqual(['ci']);

    const undeclared = setupIsolatedCiProject({
      declareOptionalDep: false,
      ciInstallsDep: false,
      failInstallAttempts: 0,
    });
    expect(undeclared.result.status).toBe(0);
    expect(undeclared.calls.map((c) => c.subcmd)).toEqual(['ci']);
  });
});
