import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The child-subagent poll used to list every one of the 30 recent day
 * directories and stat every rollout file in them, every 2 s, for every Codex
 * session -- 2.2 s of main-thread `stat` per 120 s in a real profile. It must
 * now cost about one stat per directory plus the hot files, while still
 * discovering children, growth and completion exactly as before.
 */

const listed: string[] = [];
const statted: string[] = [];

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: actual,
    readdir: async (path: any, ...rest: any[]) => {
      listed.push(String(path));
      return (actual.readdir as any)(path, ...rest);
    },
    stat: async (path: any, ...rest: any[]) => {
      statted.push(String(path));
      return (actual.stat as any)(path, ...rest);
    },
  };
});

const { mkdtemp, mkdir, rm, writeFile, appendFile, stat, utimes } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { CodexSdkProvider } = await import('../../src/agent/providers/codex-sdk.js');
const { codexSessionDir, recentCodexSessionDirs } = await import('../../src/util/codex-rollout-path.js');

const PARENT_THREAD = 'thread-parent';
const FIRST_CHILD = '11111111-2222-3333-4444-555555555555';
const SECOND_CHILD = '66666666-7777-8888-9999-000000000000';
const ARCHIVE_DAYS = 12;
const FILES_PER_DAY = 40;

let codexHome: string;

const spawnLine = (agentId: string) => ({
  timestamp: new Date().toISOString(),
  type: 'response_item',
  payload: {
    type: 'message', id: agentId, cwd: '/tmp/project',
    source: { subagent: { thread_spawn: { parent_thread_id: PARENT_THREAD, agent_name: 'scout' } } },
  },
});
const parentMetaLine = () => ({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { type: 'session_meta', cwd: '/tmp/other' } });
const completeLine = (message: string) => ({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_complete', last_agent_message: message } });
const serialize = (lines: unknown[]) => `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;

function dirFor(daysAgo: number): string {
  return codexSessionDir(codexHome, new Date(Date.now() - daysAgo * 86_400_000));
}

async function seedArchive(): Promise<void> {
  const old = new Date(Date.now() - 3 * 86_400_000);
  for (let day = 1; day <= ARCHIVE_DAYS; day += 1) {
    const dir = dirFor(day);
    await mkdir(dir, { recursive: true });
    for (let n = 0; n < FILES_PER_DAY; n += 1) {
      const file = join(dir, `rollout-2026-09-${day}-${n}-aaaaaaaa-bbbb-cccc-dddd-${String(n).padStart(12, '0')}.jsonl`);
      await writeFile(file, serialize([parentMetaLine()]), 'utf8');
      await utimes(file, old, old);
    }
    await utimes(dir, old, old);
  }
}

function makeState() {
  return {
    threadId: PARENT_THREAD,
    imcodesSessionName: 'deck_index_brain',
    cwd: '/tmp/project',
    env: { CODEX_HOME: codexHome },
    childSubagentRolloutStartedAt: Date.now() - 60_000,
    childSubagentRolloutSeenIds: new Set<string>(),
    childSubagentRolloutCompletedIds: new Set<string>(),
  };
}

function makeProvider() {
  const provider = new CodexSdkProvider();
  const emitted: Array<{ agentId: string; status: unknown }> = [];
  (provider as any).emitTrackedSubagentSnapshot = (tracked: any, status: unknown) => {
    emitted.push({ agentId: tracked.agentId, status });
  };
  return { provider, emitted };
}

const scan = (provider: any, state: unknown) => provider.scanChildSubagentRollouts('sess-1', state);
const fsCalls = () => listed.length + statted.length;

beforeEach(async () => {
  listed.length = 0;
  statted.length = 0;
  codexHome = await mkdtemp(join(tmpdir(), 'imcodes-codex-index-'));
  await seedArchive();
});

afterEach(async () => {
  await rm(codexHome, { recursive: true, force: true });
});

describe('child-subagent rollout poll cost on a large archive', () => {
  it('costs about a stat per directory after the first poll, versus a stat per archived file before', async () => {
    const today = dirFor(0);
    await mkdir(today, { recursive: true });
    const childPath = join(today, `rollout-2026-09-30T00-00-00-${FIRST_CHILD}.jsonl`);
    await writeFile(childPath, serialize([spawnLine(FIRST_CHILD)]), 'utf8');
    const { provider, emitted } = makeProvider();
    const state = makeState();

    await scan(provider, state);
    expect(emitted.map((entry) => entry.agentId)).toEqual([FIRST_CHILD]);
    const firstPollCalls = fsCalls();

    const naiveBaselinePerPoll = recentCodexSessionDirs(codexHome).length + ARCHIVE_DAYS * FILES_PER_DAY + 1;
    expect(firstPollCalls).toBeGreaterThanOrEqual(ARCHIVE_DAYS * FILES_PER_DAY);

    listed.length = 0;
    statted.length = 0;
    await scan(provider, state);
    const laterPollCalls = fsCalls();
    const directories = recentCodexSessionDirs(codexHome).length;
    // <= one stat per directory, one hot-file stat in discovery, one inside the incremental fold,
    // and at most the re-listing of the still-being-written "today" directory.
    expect(laterPollCalls).toBeLessThanOrEqual(directories + 3);
    expect(statted.filter((path) => path.includes('-aaaaaaaa-'))).toHaveLength(0);
    expect(naiveBaselinePerPoll / laterPollCalls).toBeGreaterThan(10);
  });

  it('still discovers a child that appears later, in a directory that was already indexed', async () => {
    const yesterday = dirFor(1);
    const { provider, emitted } = makeProvider();
    const state = makeState();
    await scan(provider, state);
    expect(emitted).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const later = join(yesterday, `rollout-2026-09-29T00-00-00-${SECOND_CHILD}.jsonl`);
    await writeFile(later, serialize([spawnLine(SECOND_CHILD)]), 'utf8');
    await scan(provider, state);
    expect(emitted.map((entry) => entry.agentId)).toEqual([SECOND_CHILD]);
  });

  it('still observes growth and completion of a known child', async () => {
    const today = dirFor(0);
    await mkdir(today, { recursive: true });
    const childPath = join(today, `rollout-2026-09-30T00-00-00-${FIRST_CHILD}.jsonl`);
    await writeFile(childPath, serialize([spawnLine(FIRST_CHILD)]), 'utf8');
    const { provider, emitted } = makeProvider();
    const state = makeState();
    await scan(provider, state);
    await scan(provider, state);
    expect(emitted.map((entry) => entry.status)).toEqual(['running']);

    await appendFile(childPath, serialize([completeLine('finished')]), 'utf8');
    const info = await stat(childPath);
    const next = new Date(info.mtimeMs + 5_000);
    await utimes(childPath, next, next);
    await scan(provider, state);
    expect(emitted.at(-1)?.status).toEqual({ completed: 'finished' });
    expect(state.childSubagentRolloutCompletedIds.has(FIRST_CHILD)).toBe(true);
  });
});
