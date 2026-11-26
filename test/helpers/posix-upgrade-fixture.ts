/**
 * A scratch nvm-shaped npm prefix with a live `imcodes@1.0.0`, plus a fake npm (a
 * node script that builds a package tree under `--prefix`, with injectable
 * failures and delays) and a fake daemon, for the staged-upgrade tests. Nothing
 * here touches a real install, daemon or ~/.imcodes.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FAKE_NPM = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const env = process.env;
const P = env.FAKE_PREFIX;
const cmd = argv[0];
if (cmd === 'prefix') { console.log(P); process.exit(0); }
if (cmd === 'root') { console.log(path.join(P, 'lib', 'node_modules')); process.exit(0); }
if (cmd === 'view') {
  if (argv.includes('dist.unpackedSize')) { console.log(env.FAKE_UNPACKED || '1000'); process.exit(0); }
  console.log(argv[argv.length - 2].split('@')[1]); process.exit(0);
}
if (cmd === 'install') {
  const at = argv.indexOf('--prefix');
  const spec = argv[argv.length - 1];
  if (at < 0) { console.error('npm error the fake npm only supports --prefix installs here'); process.exit(3); }
  const version = spec.split('@')[1];
  const dir = path.join(argv[at + 1], 'lib', 'node_modules', 'imcodes');
  fs.mkdirSync(path.join(dir, 'dist', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'imcodes', version, bin: { imcodes: 'dist/src/index.js' } }));
  if (env.FAKE_STARTED_FILE) fs.writeFileSync(env.FAKE_STARTED_FILE, String(process.pid));
  if (env.FAKE_INSTALL_DELAY_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(env.FAKE_INSTALL_DELAY_MS));
  // A gate instead of a fixed delay: npm stays mid-install until the test releases it (capped, so a lost test cannot hang it).
  if (env.FAKE_INSTALL_GATE_FILE) {
    const napper = new Int32Array(new SharedArrayBuffer(4));
    for (let waited = 0; waited < 120000 && !fs.existsSync(env.FAKE_INSTALL_GATE_FILE); waited += 25) Atomics.wait(napper, 0, 0, 25);
  }
  if (env.FAKE_NPM_MODE === 'fail-mid') { console.error('npm error code EINJECTED'); console.error('npm error injected failure halfway through the install'); process.exit(1); }
  const printed = env.FAKE_NPM_MODE === 'wrong-version' ? '9.9.9' : version;
  const entry = env.FAKE_NPM_MODE === 'broken-entry'
    ? "throw new Error('boom');"
    : "console.log(" + JSON.stringify(printed) + ");";
  if (env.FAKE_NPM_MODE !== 'missing-entry') fs.writeFileSync(path.join(dir, 'dist', 'src', 'index.js'), entry);
  for (const dep of ['sharp', 'detect-libc', 'semver', '@img/colour']) {
    fs.mkdirSync(path.join(dir, 'node_modules', dep), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', dep, 'package.json'), '{}');
  }
  process.exit(0);
}
console.error('npm error fake npm does not implement ' + cmd); process.exit(3);
`;

export interface Fixture {
  root: string; prefix: string; globalRoot: string; binDir: string; nodeDir: string; stateDir: string; scriptDir: string; home: string;
  livePackage: string;
}


export function writePackage(dir: string, version: string, extra: { entry?: string } = {}) {
  mkdirSync(join(dir, 'dist', 'src'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', 'sharp'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'imcodes', version, bin: { imcodes: 'dist/src/index.js' } }));
  writeFileSync(join(dir, 'dist', 'src', 'index.js'), extra.entry ?? `console.log(${JSON.stringify(version)});`);
  writeFileSync(join(dir, 'node_modules', 'sharp', 'package.json'), '{}');
}

export function treeHash(dir: string): string {
  const hash = createHash('sha256');
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const stat = statSync(full);
      hash.update(full.slice(dir.length));
      if (stat.isDirectory()) walk(full); else hash.update(readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest('hex');
}

export function startDaemon(fixture: Fixture, children: ChildProcess[]): number {
  const child = spawn('sleep', ['300'], { stdio: 'ignore', detached: true });
  child.unref();
  children.push(child);
  writeFileSync(join(fixture.stateDir, 'daemon.pid'), String(child.pid));
  return child.pid!;
}

export const START_NEW_DAEMON = (stateDir: string) => `OLD=$(cat "${stateDir}/daemon.pid" 2>/dev/null); [ -n "$OLD" ] && kill "$OLD" 2>/dev/null
nohup sleep 300 >/dev/null 2>&1 &
echo $! > "${stateDir}/daemon.pid"`;


/** Create the scratch prefix: live 1.0.0, bin link, fake node + npm. */
export function createFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'imcodes-atomic-upgrade-')));
  // An nvm-shaped prefix: ~/.nvm/versions/node/<v>/lib/node_modules
  const prefix = join(root, 'home', '.nvm', 'versions', 'node', 'v22.22.2');
  const globalRoot = join(prefix, 'lib', 'node_modules');
  const nodeDir = join(root, 'nodebin');
  mkdirSync(globalRoot, { recursive: true });
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  mkdirSync(nodeDir, { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(root, 'scratch'), { recursive: true });
  symlinkSync(process.execPath, join(nodeDir, 'node'));
  writeFileSync(join(nodeDir, 'npm'), FAKE_NPM, { mode: 0o755 });
  chmodSync(join(nodeDir, 'npm'), 0o755);
  const livePackage = join(globalRoot, 'imcodes');
  writePackage(livePackage, '1.0.0');
  symlinkSync('../lib/node_modules/imcodes/dist/src/index.js', join(prefix, 'bin', 'imcodes'));
  return {
    root, prefix, globalRoot, binDir: join(prefix, 'bin'), nodeDir, stateDir: join(root, 'state'), scriptDir: join(root, 'scratch'),
    home: join(root, 'home'), livePackage,
  };
}

/** Kill what the test started and remove the scratch tree. */
export function destroyFixture(fixture: Fixture, children: ChildProcess[]): void {
  for (const child of children.splice(0)) {
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
    try { child.kill('SIGKILL'); } catch { /* gone */ }
  }
  try { chmodSync(fixture.globalRoot, 0o755); } catch { /* removed */ }
  try { chmodSync(join(fixture.prefix, 'lib'), 0o755); } catch { /* removed */ }
  rmSync(fixture.root, { recursive: true, force: true });
}
