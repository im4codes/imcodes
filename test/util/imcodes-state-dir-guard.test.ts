/**
 * Guard: nothing may build a path under the IM.codes state directory by itself.
 *
 * A scoped or test daemon (IMCODES_HOME set) must never touch the machine's real ~/.imcodes. That holds only while every module asks
 * the one resolver (src/util/imcodes-state-dir.ts -> resolveImcodesHome) instead of joining `homedir()` with `.imcodes`. This test
 * scans the shipped sources for the `.imcodes` path segment and fails on any occurrence outside the reviewed list below, so a new
 * call site cannot quietly reintroduce the bug.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..');
const SCAN_ROOTS = ['src', 'shared', 'bin', 'scripts'];
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.sh', '.cmd', '.ps1']);

/** Files that may spell the `.imcodes` segment, each with the reason (kept next to the code it excuses). */
const ALLOWED: Record<string, string> = {
  'src/util/imcodes-state-dir.ts': 'the resolver facade: IMCODES_STATE_DIR_NAME lives here',
  'src/util/windows-daemon-lock.ts': 'resolveImcodesHome itself: the default and Windows profile rules',
  'src/util/windows-launch-preflight.mjs': 'standalone launcher script (node builtins only): inline IMCODES_HOME rule, parity-tested',
  'src/util/windows-upgrade-runner.mjs': 'copied ALONE to %TEMP% (no relative imports): inline IMCODES_HOME rule, parity-tested',
  'src/util/preinstall-cleanup.mjs': 'runs alone at npm-install time: inline IMCODES_HOME rule',
  'src/util/windows-launch-artifacts.ts': 'watchdog .cmd default line: %USERPROFILE%-based default install home',
  'src/util/test-home-guard.ts': 'names the REAL ~/.imcodes (from passwd) on purpose so tests can refuse to open it',
  'src/node/local-daemon-discovery.ts': 'reads ANOTHER local account\'s server.json by design',
  'src/daemon/remote-desktop-daemon.ts': 'explicit `home` argument (a caller-supplied account home), else the resolver',
  'src/agent/provider-quota.ts': 'tmpdir() store under test',
  'src/agent/claude-usage-quota.ts': 'tmpdir() store under test',
  'shared/skill-store.ts': 'getUserSkillRoot(homeDir, stateDir): the explicit-account-home default; shared/ cannot import src/',
  'shared/capability-management.ts': 'managed-skill root segments under an explicit account home',
  'scripts/restart-daemon.sh': 'restarts the DEFAULT launchd service (label imcodes.daemon), which by definition lives in $HOME/.imcodes',
  'scripts/diagnose-windows-controlled-node.ps1': 'reads the default SYSTEM-profile service log of a controlled node',
};

// `.imcodes` as a whole path segment: quoted, or between slashes. `.imcodes-foo` and `cc.imcodes.daemon` are different names.
const SEGMENT = /(?:['"`]\.imcodes['"`]|[/\\]\.imcodes(?=[/\\'"`\s$]|$))/;
const STATE_DIR_AWARE = /IMCODES_HOME|IMCODES_STATE_DIR|imcodesStateDir/;

function walk(directory: string, out: string[]): void {
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(directory, entry);
    const info = statSync(full);
    if (info.isDirectory()) walk(full, out);
    else if (SCAN_EXTENSIONS.has(entry.slice(entry.lastIndexOf('.'))) && !/\.test\.[cm]?[jt]sx?$/.test(entry)) out.push(full);
  }
}

function isComment(line: string): boolean {
  return /^\s*(\/\/|\*|\/\*|#|rem\b|<!--)/i.test(line);
}

function scan(): Array<{ file: string; line: number; text: string }> {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root), files);
  const violations: Array<{ file: string; line: number; text: string }> = [];
  for (const file of files) {
    const rel = relative(REPO_ROOT, file).split(sep).join('/');
    if (rel in ALLOWED) continue;
    readFileSync(file, 'utf8').split('\n').forEach((text, index) => {
      if (isComment(text) || !SEGMENT.test(text)) return;
      // `~/.imcodes` inside prose (a message or doc string) is documentation, not a path the process opens.
      if (/~[/\\]\.imcodes/.test(text) && !/(join|resolve)\(/.test(text)) return;
      // Scripts and shell that already derive the location from IMCODES_HOME on the same line are state-dir aware.
      if (!rel.endsWith('.ts') && !rel.endsWith('.tsx') && STATE_DIR_AWARE.test(text)) return;
      violations.push({ file: rel, line: index + 1, text: text.trim().slice(0, 160) });
    });
  }
  return violations;
}

describe('IMCODES_HOME reaches every state path', () => {
  it('no shipped source joins an account home with the `.imcodes` segment outside the reviewed resolver files', () => {
    expect(scan()).toEqual([]);
  });

  it('every allowed exception still exists and still needs its exception', () => {
    for (const rel of Object.keys(ALLOWED)) {
      const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
      expect(SEGMENT.test(text) || text.includes("'.imcodes'"), `${rel} no longer mentions .imcodes: drop it from ALLOWED`).toBe(true);
    }
  });

  it('no TypeScript module carries its own IMCODES_HOME || homedir() copy of the resolver', () => {
    const files: string[] = [];
    for (const root of ['src', 'shared']) walk(join(REPO_ROOT, root), files);
    const copies = files
      .map((file) => relative(REPO_ROOT, file).split(sep).join('/'))
      .filter((rel) => rel.endsWith('.ts') && !(rel in ALLOWED))
      .filter((rel) => /IMCODES_HOME[^\n]*homedir\(\)|homedir\(\)[^\n]*IMCODES_HOME/.test(readFileSync(join(REPO_ROOT, rel), 'utf8')));
    expect(copies).toEqual([]);
  });
});
