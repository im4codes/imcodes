import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isDirectInvocation, resolveNpmCliJs } from '../../src/util/node-datachannel-repair.mjs';
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

  it('runs only the dependency lifecycle with scripts explicitly enabled', () => {
    const implementation = readFileSync(join(process.cwd(), 'src', 'util', 'node-datachannel-repair.mjs'), 'utf8');
    expect(implementation).toContain("'rebuild', '--global=false', '--prefix', packageRoot");
    expect(implementation).toContain("'node-datachannel', '--ignore-scripts=false', '--foreground-scripts'");
    expect(implementation).toContain("'install', '--global=false', '--prefix', packageRoot");
    expect(implementation).toContain("'--no-save', '--ignore-scripts=false', '--foreground-scripts'");
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
