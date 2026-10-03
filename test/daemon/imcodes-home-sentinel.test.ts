/**
 * Acceptance: a daemon process with IMCODES_HOME=<scoped dir> and HOME/USERPROFILE pointing at a SENTINEL account home creates and
 * opens nothing under <sentinel>/.imcodes. The stores are driven in a real child process (tsx), not with mocked paths, because the
 * bug class is "some module computed its own homedir()-based path at import or first use".
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** Everything the child touches. It prints the paths each subsystem resolved so the assertions can pin them individually. */
const CHILD_SOURCE = (root: string) => `
import { configureSessionStoreWriteAuthority, flushStore, loadStore, upsertSession } from '${root}/src/store/session-store.ts';
import { acquireInstanceLock, releaseInstanceLock } from '${root}/src/daemon/instance-lock.ts';
import { getTaskPairStore, resolveTaskPairsDbPath } from '${root}/src/daemon/task-pairs/store.ts';
import { registerMemoryShortRef, loadMemoryShortRefsFromStore } from '${root}/src/context/memory-short-ref.ts';
import { hookPortFilePath, publishHookAuthority } from '${root}/src/daemon/hook-port.ts';
import { getProjectionDbPath, timelineProjection } from '${root}/src/daemon/timeline-projection.ts';
import { existsSync } from 'node:fs';
import { resolveTaskPairTaskDir } from '${root}/src/daemon/task-pairs/workspace.ts';

// The same start-up order as the daemon: instance lock, then write authority for the session store, then load and persist.
const lock = await acquireInstanceLock();
configureSessionStoreWriteAuthority(lock.identity, lock.metadataPath);
await loadStore();
upsertSession({
  name: 'deck_sentinel_brain', projectName: 'sentinel', role: 'brain', agentType: 'shell', projectDir: '${root}',
  state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
});
await flushStore();
getTaskPairStore();
registerMemoryShortRef({ kind: 'projection', id: 'sentinel-proof', namespace: { scope: 'personal', projectId: 'p' } });
await loadMemoryShortRefsFromStore();
const published = await publishHookAuthority(43219);
await timelineProjection.queryLatest('deck_sentinel_brain');
// The worker thread boots slowly under tsx: its first request may time out on the client while the message is still queued, so
// wait for the worker to open its database (up to 20 s) before shutting it down.
for (let i = 0; i < 200 && !existsSync(getProjectionDbPath()); i += 1) await new Promise((r) => setTimeout(r, 100));
await timelineProjection.drain(5000);
await timelineProjection.shutdown();
console.log('RESOLVED ' + JSON.stringify({
  hookPort: hookPortFilePath(),
  taskPairs: resolveTaskPairsDbPath(),
  timeline: getProjectionDbPath(),
  pairTaskDir: resolveTaskPairTaskDir('proj', 'tsk_x'),
  hookPublished: published.published,
  lockSocket: lock.socketPath,
}));
await releaseInstanceLock(lock);
process.exit(0);
`;

function inventory(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const info = statSync(full);
      out.push(`${relative(root, full)}\t${info.isDirectory() ? 'dir' : info.size}`);
      if (info.isDirectory()) walk(full);
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

function runChild(env: Record<string, string>, scratch: string) {
  const script = join(scratch, 'child.mts');
  writeFileSync(script, CHILD_SOURCE(REPO_ROOT));
  const result = spawnSync(process.execPath, ['--import', 'tsx', script], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const line = result.stdout.split('\n').find((l) => l.startsWith('RESOLVED '));
  if (!line) throw new Error(`child produced no result (status ${result.status}): ${result.stderr.slice(-1500)}`);
  return JSON.parse(line.slice('RESOLVED '.length)) as Record<string, string | boolean>;
}

describe('IMCODES_HOME is honoured by a real process (sentinel HOME)', () => {
  const scratchDirs: string[] = [];
  afterEach(() => { while (scratchDirs.length) rmSync(scratchDirs.pop()!, { recursive: true, force: true }); });
  const scratch = () => { const d = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'imcs-')); scratchDirs.push(d); return d; };

  it('creates and opens nothing under HOME/.imcodes; everything lands in IMCODES_HOME', () => {
    const base = scratch();
    const sentinelHome = join(base, 'sentinel-home');
    const stateDir = join(base, 'scoped-state');
    mkdirSync(sentinelHome, { recursive: true });
    writeFileSync(join(sentinelHome, '.profile'), 'sentinel');
    const before = inventory(sentinelHome);

    const resolved = runChild({ HOME: sentinelHome, USERPROFILE: sentinelHome, IMCODES_HOME: stateDir }, base);

    expect(inventory(sentinelHome)).toEqual(before);
    expect(existsSync(join(sentinelHome, '.imcodes'))).toBe(false);
    for (const key of ['hookPort', 'taskPairs', 'timeline', 'pairTaskDir', 'lockSocket'] as const) {
      expect(String(resolved[key]).startsWith(stateDir), `${key} -> ${resolved[key]}`).toBe(true);
    }
    // The subsystems really created their files in the scoped directory.
    const created = readdirSync(stateDir);
    // shared-agent-context.sqlite is where the memory short refs (and the rest of the context store) persist.
    expect(created).toEqual(expect.arrayContaining(['sessions.sqlite', 'task-pairs.sqlite', 'timeline.sqlite', 'shared-agent-context.sqlite']));
    expect(existsSync(String(resolved.hookPort))).toBe(resolved.hookPublished === true);
    expect(existsSync(join(stateDir, 'logs'))).toBe(true);
  }, 90_000);

  it('with IMCODES_HOME unset the same process uses <HOME>/.imcodes (default unchanged)', () => {
    const base = scratch();
    const home = join(base, 'plain-home');
    mkdirSync(home, { recursive: true });
    const resolved = runChild({ HOME: home, USERPROFILE: home }, base);
    const stateDir = join(home, '.imcodes');
    expect(resolved.hookPort).toBe(join(stateDir, 'hook-port'));
    expect(resolved.taskPairs).toBe(join(stateDir, 'task-pairs.sqlite'));
    expect(resolved.timeline).toBe(join(stateDir, 'timeline.sqlite'));
    expect(readdirSync(stateDir)).toEqual(expect.arrayContaining(['sessions.sqlite', 'task-pairs.sqlite', 'timeline.sqlite', 'shared-agent-context.sqlite']));
  }, 90_000);
});
