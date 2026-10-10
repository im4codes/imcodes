/**
 * bin/imcodes-launch.mjs -- what the macOS launch agent runs under node. Real node processes against a fake package tree:
 * the repair (preflight) runs as a child BEFORE the daemon entry is imported into the same process, argv[1] becomes the entry, and a
 * missing or failing preflight never keeps the daemon from starting.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MACOS_DAEMON_LAUNCH } from '../../shared/macos-daemon-launch.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const describeUnix = process.platform === 'win32' ? describe.skip : describe;

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'launch-bootstrap-'))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function makePackage(options: { preflight?: string | false; entry?: string }): { pkg: string; bootstrap: string; marker: string; order: string } {
  const pkg = join(root, 'pkg');
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  mkdirSync(join(pkg, 'dist', 'src'), { recursive: true });
  const marker = join(root, 'entry.json');
  const order = join(root, 'order.log');
  copyFileSync(join(REPO, 'bin', 'imcodes-launch.mjs'), join(pkg, 'bin', 'imcodes-launch.mjs'));
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'imcodes', version: '1.0.0' }));
  writeFileSync(join(pkg, 'dist', 'src', 'index.js'), options.entry ?? `
    import { appendFileSync, writeFileSync } from 'node:fs';
    appendFileSync(${JSON.stringify(order)}, 'entry\\n');
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ argv: process.argv.slice(1), preflightEnv: process.env.${MACOS_DAEMON_LAUNCH.PREFLIGHT_ONLY_ENV} ?? null }));
  `);
  if (options.preflight !== false) {
    const body = options.preflight ?? `#!/bin/bash\necho "preflight $IMCODES_LAUNCH_PREFLIGHT_ONLY $@ node=$IMCODES_NODE_BIN" >> ${JSON.stringify(order)}\nexit 0\n`;
    writeFileSync(join(pkg, 'bin', 'imcodes-launch.sh'), body);
    chmodSync(join(pkg, 'bin', 'imcodes-launch.sh'), 0o755);
  }
  return { pkg, bootstrap: join(pkg, 'bin', 'imcodes-launch.mjs'), marker, order };
}

function run(bootstrap: string): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [bootstrap, 'start', '--foreground'], { encoding: 'utf8', timeout: 20_000 });
  return { status: result.status, stderr: result.stderr };
}

describeUnix('bin/imcodes-launch.mjs', () => {
  it('runs the preflight as a child first (preflight-only, with this node), then imports the entry into the same process', () => {
    const { bootstrap, marker, order, pkg } = makePackage({});
    const result = run(bootstrap);
    expect(result.status).toBe(0);
    const log = readFileSync(order, 'utf8').trim().split('\n');
    expect(log[0]).toBe(`preflight 1 start --foreground node=${process.execPath}`);
    expect(log[1]).toBe('entry');
    const seen = JSON.parse(readFileSync(marker, 'utf8')) as { argv: string[]; preflightEnv: string | null };
    // the daemon sees the entry as its script (self-restart, recovery units and the main-module check read argv[1]) and plain arguments
    expect(seen.argv).toEqual([join(pkg, 'dist', 'src', 'index.js'), 'start', '--foreground']);
    // the preflight-only switch exists for the child only
    expect(seen.preflightEnv).toBeNull();
  });

  it('a preflight that fails, hangs up or is absent never stops the daemon from starting', () => {
    const failing = makePackage({ preflight: '#!/bin/bash\nexit 7\n' });
    const failed = run(failing.bootstrap);
    expect(failed.status).toBe(0);
    expect(existsSync(failing.marker)).toBe(true);
    expect(failed.stderr).toContain('preflight exited with 7');
    rmSync(join(root, 'pkg'), { recursive: true, force: true });
    rmSync(join(root, 'entry.json'), { force: true });
    const absent = makePackage({ preflight: false });
    expect(run(absent.bootstrap).status).toBe(0);
    expect(existsSync(absent.marker)).toBe(true);
  });

  it('an entry that cannot be loaded exits 1 with the reason (launchd restarts it and the next start repairs again)', () => {
    const broken = makePackage({ entry: "import 'definitely-not-installed-package';\n" });
    const result = run(broken.bootstrap);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot start the daemon');
    expect(result.stderr).toContain('definitely-not-installed-package');
  });

  it('uses nothing but node builtins, and its literals are the shared constants', () => {
    const text = readFileSync(join(REPO, 'bin', 'imcodes-launch.mjs'), 'utf8');
    const imports = [...text.matchAll(/^import .* from '([^']+)'/gmu)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const source of imports) expect(source).toMatch(/^node:/u);
    expect(text).toContain(`'${MACOS_DAEMON_LAUNCH.PREFLIGHT_ONLY_ENV}'`);
    expect(text).toContain(`'${MACOS_DAEMON_LAUNCH.NODE_BIN_ENV}'`);
    expect(text).toContain("join(PKG_ROOT, 'dist', 'src', 'index.js')");
    expect(MACOS_DAEMON_LAUNCH.ENTRY_RELATIVE).toBe('dist/src/index.js');
    expect(text).toContain("join(PKG_ROOT, 'bin', 'imcodes-launch.sh')");
    expect(MACOS_DAEMON_LAUNCH.PREFLIGHT_RELATIVE).toBe('bin/imcodes-launch.sh');
    expect(MACOS_DAEMON_LAUNCH.BOOTSTRAP_RELATIVE).toBe('bin/imcodes-launch.mjs');
  });
});

describeUnix('bin/imcodes-launch.sh in preflight-only mode', () => {
  it('does the repairs and returns without starting the daemon; without the switch it still hands off to node', () => {
    const pkg = join(root, 'pkg2');
    mkdirSync(join(pkg, 'bin'), { recursive: true });
    mkdirSync(join(pkg, 'dist', 'src'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'imcodes', version: '1.2.3' }));
    writeFileSync(join(pkg, 'dist', 'src', 'index.js'), 'console.log("entry-ran");\n');
    copyFileSync(join(REPO, 'bin', 'imcodes-launch.sh'), join(pkg, 'bin', 'imcodes-launch.sh'));
    chmodSync(join(pkg, 'bin', 'imcodes-launch.sh'), 0o755);
    const env = { ...process.env, HOME: root, IMCODES_HOME: join(root, '.imcodes'), IMCODES_NODE_BIN: process.execPath, IMCODES_NPM_BIN: '' };
    const only = spawnSync('/bin/bash', [join(pkg, 'bin', 'imcodes-launch.sh'), 'start', '--foreground'], { encoding: 'utf8', env: { ...env, [MACOS_DAEMON_LAUNCH.PREFLIGHT_ONLY_ENV]: '1' }, timeout: 20_000 });
    expect(only.status).toBe(0);
    expect(only.stdout).not.toContain('entry-ran');
    const full = spawnSync('/bin/bash', [join(pkg, 'bin', 'imcodes-launch.sh'), 'start', '--foreground'], { encoding: 'utf8', env, timeout: 20_000 });
    expect(full.stdout).toContain('entry-ran');
  });
});
