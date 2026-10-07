/**
 * Guard: the daemon must not fork itself on its main thread for routine work.
 *
 * `child_process` forks the CALLING process, and fork cost grows with its memory: a 1 GB daemon pays ~27 ms of main-thread
 * kernel time (page-table copy) per spawn. 215, 2026-10-07: one periodic pass forked 830-1100 `git` children a minute
 * (perf: 21% of main-thread samples in spawnSync -> fork), a 2.4 s freeze every 60 s that held every keystroke echo.
 * The daemon starts a tiny helper process at boot (`src/util/exec-helper.ts`) and short-lived tools go through it.
 *
 * Two rules for src/daemon, src/agent, src/context and src/store:
 *  1. no `spawnSync` / `execFileSync` / `execSync` (they also block the loop until the child exits);
 *  2. no `execFile` / `exec` imported from `child_process`: use `execFileOffMain` / `execFileOffMainCallback`.
 * (`spawn` of a long-lived agent/worker child is not covered: it is one fork per session, not per call.)
 *
 * A new exception must be added below WITH its reason. A stale entry (the file no longer uses the pattern) fails too, so the
 * list cannot rot into a blanket permission.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const SCOPE = ['src/daemon', 'src/agent', 'src/context', 'src/store'];

const SYNC_RE = /\b(?:spawnSync|execFileSync|execSync)\s*\(/;
const IMPORT_RE = /import\s+(?:type\s+)?(?:\*\s+as\s+(\w+)|\{([^}]*)\})\s+from\s+'(?:node:)?child_process'/g;

/** Synchronous child processes that are allowed to stay, and why they are not a periodic main-thread cost. */
const SYNC_ALLOWLIST: Readonly<Record<string, string>> = {
  'src/agent/tmux.ts': '`which tmux`/`which wezterm` once at module init (backend detection); `preparePrivateInputWriter` is a deliberately synchronous text+Enter write whose caller re-checks authorization immediately before it and must not yield the loop. User-driven, never periodic.',
  'src/agent/wezterm.ts': 'The wezterm backend\'s synchronous send-text, the same private-input contract as tmux.ts. Not used on tmux hosts (215, 158 and mini-2 are all tmux).',
  'src/daemon/instance-lock.ts': 'Single-instance lock liveness probes at startup / lock reclaim. Linux reads /proc; only macOS and Windows fall back to ps / powershell. Not periodic.',
  'src/daemon/service-recovery-runner.ts': 'Runs as the separate service-recovery process (systemd), never inside the daemon main thread.',
  'src/daemon/subsession-manager.ts': '`where pwsh.exe`, Windows-only, once per sub-session launch.',
  'src/daemon/command-handler.ts': '`launchctl unload` / `systemctl disable` once when the owner deletes this server\'s daemon (uninstall); the process exits right after.',
  'src/daemon/supervision-integration-bundle.ts': 'Retired legacy integration path, git calls need stdin and binary stdout the helper cannot carry. Reachable only from an explicit action (an agent\'s MCP call or a legacy task being integrated), never from a periodic pass: the tick loops and dispatchReadyRework/Integration skip pairs and inert projects (isLegacyDispatchInertProject, send-tool.ts). Every exported entry is wrapped in a named watchdog phase, so a stall here names itself.',
};

/** Direct `execFile` / `exec` imports that are allowed to stay. */
const DIRECT_ALLOWLIST: Readonly<Record<string, string>> = {
  'src/daemon/controlled-node-install-here.ts': 'Owner-initiated installer run, once; not periodic.',
  'src/daemon/fs-git-status-worker.ts': 'Runs inside its own worker thread, not the main thread; the helper process is not reachable from a worker.',
  'src/daemon/remote-desktop-login-screen.ts': 'Windows-only, owner-initiated.',
  'src/daemon/supervision-worktree-inspector.ts': 'Needs stdin (`git ... --stdin`) and a binary stdout, which the helper cannot carry. Only the legacy supervision convergence / MCP paths reach it, those are guarded by isLegacyDispatchInertProject, and it limits itself with its own git concurrency slot.',
  'src/agent/agent-version.ts': 'Agent CLI version probe, cached per agent for the daemon\'s life.',
  'src/agent/cursor-runtime-config.ts': 'One-shot runtime-config probe at session setup, exec function injectable.',
  'src/agent/qwen-runtime-config.ts': 'One-shot runtime-config probe at session setup, exec function injectable.',
  'src/agent/providers/qwen.ts': '`qwen --version` once per provider connect.',
};

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { yield* sourceFiles(full); continue; }
    if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) yield full;
  }
}

function usesDirectExec(text: string): boolean {
  for (const match of text.matchAll(IMPORT_RE)) {
    if (match[0].startsWith('import type')) continue;
    if (match[1]) {
      if (new RegExp(`\\b${match[1]}\\.(?:execFile|exec)\\b`).test(text)) return true;
      continue;
    }
    const names = (match[2] ?? '').split(',').map((part) => part.trim().split(/\s+as\s+/)[0]!.trim());
    if (names.some((name) => name === 'execFile' || name === 'exec')) return true;
  }
  return false;
}

const files = SCOPE.flatMap((dir) => [...sourceFiles(join(ROOT, dir))]).map((file) => ({
  path: relative(ROOT, file).split(sep).join('/'),
  text: readFileSync(file, 'utf8'),
}));

describe('no synchronous or direct child process on the daemon main thread', () => {
  it('scans a non-trivial set of files (the guard cannot silently pass on an empty scan)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((file) => file.path === 'src/daemon/command-handler.ts')).toBe(true);
  });

  it('no spawnSync / execFileSync / execSync outside the allowlist', () => {
    const offenders = files.filter((file) => SYNC_RE.test(file.text) && !(file.path in SYNC_ALLOWLIST)).map((file) => file.path);
    expect(offenders, `${offenders.join(', ')} call a synchronous child process on the main thread. Use execFileOffMain (src/util/exec-helper.ts), or add the file to SYNC_ALLOWLIST with the reason it is not a periodic cost.`).toEqual([]);
  });

  it('no execFile / exec from child_process outside the allowlist', () => {
    const offenders = files.filter((file) => usesDirectExec(file.text) && !(file.path in DIRECT_ALLOWLIST)).map((file) => file.path);
    expect(offenders, `${offenders.join(', ')} fork the daemon directly. Use execFileOffMain / execFileOffMainCallback (src/util/exec-helper.ts), or add the file to DIRECT_ALLOWLIST with the reason.`).toEqual([]);
  });

  it('every allowlist entry is still needed and carries a reason (the list cannot rot)', () => {
    const byPath = new Map(files.map((file) => [file.path, file.text]));
    for (const [path, reason] of Object.entries(SYNC_ALLOWLIST)) {
      expect(reason.length, `${path}: reason`).toBeGreaterThan(20);
      expect(byPath.has(path), `${path} no longer exists`).toBe(true);
      expect(SYNC_RE.test(byPath.get(path)!), `${path} no longer uses a synchronous child process: remove it from SYNC_ALLOWLIST`).toBe(true);
    }
    for (const [path, reason] of Object.entries(DIRECT_ALLOWLIST)) {
      expect(reason.length, `${path}: reason`).toBeGreaterThan(20);
      expect(byPath.has(path), `${path} no longer exists`).toBe(true);
      expect(usesDirectExec(byPath.get(path)!), `${path} no longer forks directly: remove it from DIRECT_ALLOWLIST`).toBe(true);
    }
  });

  it('the matchers catch the shapes they exist for (so a rename cannot hide a violation)', () => {
    expect(SYNC_RE.test("const out = execFileSync('git', ['status'])")).toBe(true);
    expect(SYNC_RE.test('spawnSync("git", args, { input })')).toBe(true);
    expect(SYNC_RE.test('const { stdout } = await execFileOffMain("git", args)')).toBe(false);
    expect(usesDirectExec("import { execFile } from 'node:child_process';\nexecFile('git', [])")).toBe(true);
    expect(usesDirectExec("import { execFile as run, spawn } from 'child_process';")).toBe(true);
    expect(usesDirectExec("import * as cp from 'node:child_process';\ncp.execFile('git', [])")).toBe(true);
    expect(usesDirectExec("import { spawn } from 'node:child_process';")).toBe(false);
    expect(usesDirectExec("import type { ExecFileOptions } from 'node:child_process';")).toBe(false);
    expect(usesDirectExec("import { execFileOffMainCallback as execFile } from '../../util/exec-helper.js';")).toBe(false);
  });
});
