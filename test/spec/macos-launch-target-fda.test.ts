/**
 * Spec: no macOS launch agent the product writes may start a script.
 *
 * macOS attributes Full Disk Access to the program launchd starts. A plist whose program is `#!/usr/bin/env bash ...` is checked as
 * `/usr/bin/env` on older macOS (measured on 12.7.6: responsible_path=/usr/bin/env, authValue=0), so the grant the user made on
 * node never reached the daemon or the agent sessions it starts. This fails if any producer of the plist goes back to a script:
 * every way the plist gets written is run on a package that ships the shell supervisor, and the program that comes out is read.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MACOS_LAUNCH_MIGRATION_MODE, hasInterpreterLine, parsePlistProgramArguments } from '../../shared/macos-daemon-launch.js';
import {
  ensureMacosLaunchAgentTarget,
  planMacosPlistProgramArguments,
  renderMacosLaunchAgentPlist,
  resolveMacosDaemonLaunchFacts,
} from '../../src/util/macos-launch-agent.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'spec-macos-launch-'))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function fixture(): { entry: string; node: string; launcher: string } {
  const pkg = join(root, 'lib', 'node_modules', 'imcodes');
  mkdirSync(join(pkg, 'dist', 'src'), { recursive: true });
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), '{"name":"imcodes"}');
  const entry = join(pkg, 'dist', 'src', 'index.js');
  writeFileSync(entry, '');
  // the real supervisor, exactly as shipped: an env-shebang script
  const launcher = join(pkg, 'bin', 'imcodes-launch.sh');
  writeFileSync(launcher, readFileSync(join(REPO, 'bin', 'imcodes-launch.sh')), { mode: 0o755 });
  writeFileSync(join(pkg, 'bin', 'imcodes-launch.mjs'), readFileSync(join(REPO, 'bin', 'imcodes-launch.mjs')));
  const node = join(root, 'bin', 'node');
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(node, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
  chmodSync(node, 0o755);
  return { entry, node, launcher };
}

function programOf(xml: string): string {
  return parsePlistProgramArguments(xml)![0]!;
}

function expectNotAScript(program: string): void {
  expect(readFileSync(program).subarray(0, 2).toString('latin1')).not.toBe('#!');
  expect(hasInterpreterLine(readFileSync(program).subarray(0, 2).toString('latin1'))).toBe(false);
}

describe('spec: a macOS plist never points at an env-shebang script', () => {
  it('the shipped supervisor really is such a script (so the check below means something)', () => {
    const { launcher } = fixture();
    expect(readFileSync(launcher, 'utf8').startsWith('#!/usr/bin/env bash')).toBe(true);
  });

  it('install / re-bind: the rendered plist runs node', () => {
    const { entry, node } = fixture();
    const args = planMacosPlistProgramArguments(resolveMacosDaemonLaunchFacts({ entry, node, pathEnv: '' }));
    const xml = renderMacosLaunchAgentPlist({ label: 'imcodes.daemon', programArguments: args, logPath: '/l', pathEnv: '/usr/bin', home: '/h', nodeOptions: '' });
    expectNotAScript(programOf(xml));
  });

  it('upgrade from an older daemon that wrote the supervisor back, and every restart / start path: the plist ends up running node', () => {
    const { entry, node, launcher } = fixture();
    for (const mode of Object.values(MACOS_LAUNCH_MIGRATION_MODE)) {
      const plist = join(root, `${mode}.plist`);
      writeFileSync(plist, `<plist><dict><key>ProgramArguments</key><array><string>${launcher}</string><string>start</string><string>--foreground</string></array></dict></plist>`);
      ensureMacosLaunchAgentTarget({ plistPath: plist, mode, entry, node, pathEnv: '' });
      expectNotAScript(programOf(readFileSync(plist, 'utf8')));
    }
  });

  it('the install flow does not take its macOS program from the Linux launch target', () => {
    const source = readFileSync(join(REPO, 'src', 'bind', 'bind-flow.ts'), 'utf8');
    const start = source.indexOf('async function installLaunchAgent()');
    const end = source.indexOf('async function installSystemdService()');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    expect(body).not.toMatch(/resolveDaemonLaunchTarget|imcodes-launch\.sh|PREFLIGHT_RELATIVE/u);
    expect(body).toContain('planMacosPlistProgramArguments');
  });

  it('the upgrade script\'s macOS branch never points ProgramArguments at the supervisor', () => {
    const source = readFileSync(join(REPO, 'src', 'util', 'posix-upgrade-script.ts'), 'utf8');
    const start = source.indexOf('elif [ "$(uname)" = "Darwin" ]; then');
    const end = source.indexOf('regenerate_launch_chain\n', start);
    expect(start).toBeGreaterThan(0);
    const branch = source.slice(start, end);
    expect(branch).toContain('ensure --plist');
    expect(branch).not.toContain('NEW_LAUNCHER');
    expect(source).not.toMatch(/DARWIN_PROGRAM_ARGS="\[[^\n]*NEW_LAUNCHER/u);
  });
});
