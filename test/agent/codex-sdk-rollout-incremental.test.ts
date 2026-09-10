import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The child-subagent rollout poll must not re-read a file it has already read.
 *
 * This poll runs every 2s per Codex session and, before the incremental scan,
 * re-read and re-`JSON.parse`d every candidate rollout from byte zero -- twice
 * per tick, because discovery ran once per predicate. On a real machine that
 * was ~90 MB of re-reading per tick, dominated by a single 83.8 MB rollout, and
 * it showed up as event-loop stalls in the daemon. Rollouts are append-only, so
 * the answer for the bytes already seen cannot change.
 *
 * These tests assert on actual file I/O (`open` calls and bytes read) rather
 * than on elapsed time, so they state the guarantee itself and cannot pass by
 * being run on a fast machine.
 */

interface ReadRecord { path: string; bytes: number }

const opened: string[] = [];
const reads: ReadRecord[] = [];
const listed: string[] = [];

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: actual,
    readdir: async (path: any, ...rest: any[]) => {
      listed.push(String(path));
      return (actual.readdir as any)(path, ...rest);
    },
    open: async (path: any, ...rest: any[]) => {
      const handle = await (actual.open as any)(path, ...rest);
      const target = String(path);
      if (target.includes('rollout-')) {
        opened.push(target);
        const originalRead = handle.read.bind(handle);
        handle.read = async (...args: any[]) => {
          const result = await originalRead(...args);
          reads.push({ path: target, bytes: result.bytesRead });
          return result;
        };
      }
      return handle;
    },
  };
});

const { mkdtemp, mkdir, rm, writeFile, appendFile, stat, utimes } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { CodexSdkProvider } = await import('../../src/agent/providers/codex-sdk.js');

const PARENT_THREAD = 'thread-parent';
const AGENT_ID = '11111111-2222-3333-4444-555555555555';

let codexHome: string;
let sessionDir: string;
let rolloutPath: string;

function spawnLine(ts: string) {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: {
      type: 'message',
      id: AGENT_ID,
      source: { subagent: { thread_spawn: { parent_thread_id: PARENT_THREAD, agent_name: 'scout' } } },
      cwd: '/tmp/project',
    },
  };
}

const usageLine = (ts: string, total: number) => ({
  timestamp: ts,
  type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total } } },
});

const completeLine = (ts: string, message: string) => ({
  timestamp: ts,
  type: 'event_msg',
  payload: { type: 'task_complete', last_agent_message: message },
});

function serialize(lines: unknown[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

/** Bump mtime forward so an append is never mistaken for an unchanged file. */
async function touchForward(path: string): Promise<void> {
  const info = await stat(path);
  const next = new Date(info.mtimeMs + 5_000);
  await utimes(path, next, next);
}

function makeState(over: Record<string, unknown> = {}) {
  return {
    threadId: PARENT_THREAD,
    imcodesSessionName: 'deck_incr_brain',
    cwd: '/tmp/project',
    env: { CODEX_HOME: codexHome },
    childSubagentRolloutStartedAt: 0,
    childSubagentRolloutSeenIds: new Set<string>(),
    childSubagentRolloutCompletedIds: new Set<string>(),
    ...over,
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

beforeEach(async () => {
  opened.length = 0;
  reads.length = 0;
  listed.length = 0;
  codexHome = await mkdtemp(join(tmpdir(), 'imcodes-codex-incr-'));
  const now = new Date();
  sessionDir = join(
    codexHome,
    'sessions',
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  );
  await mkdir(sessionDir, { recursive: true });
  rolloutPath = join(sessionDir, `rollout-2026-09-10T00-00-00-${AGENT_ID}.jsonl`);
});

afterEach(async () => {
  await rm(codexHome, { recursive: true, force: true });
});

describe('child-subagent rollout scanning is incremental', () => {
  it('reads an unchanged rollout exactly once across repeated polls', async () => {
    await writeFile(rolloutPath, serialize([spawnLine('2026-09-10T00:00:00.000Z')]), 'utf8');
    const { provider } = makeProvider();
    const state = makeState();

    await scan(provider, state);
    const afterFirst = opened.length;
    expect(afterFirst, 'the first poll must actually read the file').toBeGreaterThan(0);

    await scan(provider, state);
    await scan(provider, state);
    await scan(provider, state);

    expect(
      opened.length,
      'unchanged size+mtime means the previous fold is still exact: no file should be opened again',
    ).toBe(afterFirst);
  });

  it('walks the session directories once per poll, not once per predicate', async () => {
    await writeFile(rolloutPath, serialize([spawnLine('2026-09-10T00:00:00.000Z')]), 'utf8');
    const { provider } = makeProvider();

    await scan(provider, makeState());

    // Discovery used to run a whole traversal per predicate -- once matching
    // the parent thread, once matching the session -- so every day-dir was
    // listed and every candidate stat'd twice to answer two questions about
    // the same bytes. The read cache hides the duplicated READS, so the
    // duplicated WALK is what has to be asserted; the predicates are pure
    // functions of the snapshot and belong after the traversal.
    expect(
      listed.filter((p) => p === sessionDir),
      'one poll, one directory walk',
    ).toHaveLength(1);
    expect(opened.filter((p) => p === rolloutPath)).toHaveLength(1);
  });

  it('reads only the appended bytes when the rollout grows', async () => {
    const head = serialize([spawnLine('2026-09-10T00:00:00.000Z')]);
    await writeFile(rolloutPath, head, 'utf8');
    const { provider } = makeProvider();
    const state = makeState();
    await scan(provider, state);

    const firstPass = reads.reduce((sum, r) => sum + r.bytes, 0);
    expect(firstPass).toBe(Buffer.byteLength(head, 'utf8'));
    reads.length = 0;

    const tail = serialize([completeLine('2026-09-10T00:01:00.000Z', 'all done')]);
    await appendFile(rolloutPath, tail, 'utf8');
    await touchForward(rolloutPath);
    await scan(provider, state);

    const secondPass = reads.reduce((sum, r) => sum + r.bytes, 0);
    expect(
      secondPass,
      'a grown rollout must cost its appended bytes, not its whole length',
    ).toBe(Buffer.byteLength(tail, 'utf8'));
    expect(secondPass).toBeLessThan(firstPass);
  });

  it('still observes completion carried by the appended tail', async () => {
    await writeFile(rolloutPath, serialize([spawnLine('2026-09-10T00:00:00.000Z')]), 'utf8');
    const { provider, emitted } = makeProvider();
    const state = makeState();
    await scan(provider, state);
    expect(emitted.map((e) => e.status)).toEqual(['running']);

    await appendFile(rolloutPath, serialize([
      usageLine('2026-09-10T00:00:30.000Z', 4242),
      completeLine('2026-09-10T00:01:00.000Z', 'all done'),
    ]), 'utf8');
    await touchForward(rolloutPath);
    await scan(provider, state);

    expect(
      emitted.at(-1)?.status,
      'the fold must carry across reads: the spawn came from bytes read one poll earlier',
    ).toEqual({ completed: 'all done' });
    expect(state.childSubagentRolloutCompletedIds.has(AGENT_ID)).toBe(true);
  });

  it('rebuilds from zero when the rollout is replaced rather than appended', async () => {
    const other = '99999999-8888-7777-6666-555555555555';
    await writeFile(rolloutPath, serialize([
      spawnLine('2026-09-10T00:00:00.000Z'),
      completeLine('2026-09-10T00:01:00.000Z', 'first agent'),
      usageLine('2026-09-10T00:01:01.000Z', 10),
    ]), 'utf8');
    const { provider } = makeProvider();
    await scan(provider, makeState());

    // Same path, different content, SHORTER than before: only append-only
    // growth is resumable, so a shrink must discard the fold entirely rather
    // than resume mid-file and splice two unrelated rollouts together.
    const replaced = { ...spawnLine('2026-09-10T02:00:00.000Z') };
    (replaced.payload as any).id = other;
    await writeFile(rolloutPath, serialize([replaced]), 'utf8');
    await touchForward(rolloutPath);

    const freshState = makeState();
    const { provider: second } = makeProvider();
    await scan(second, freshState);
    const tracked = [...(second as any).trackedSubagentThreads.values()] as any[];
    expect(tracked.map((t) => t.agentId)).toEqual([other]);
    expect(
      tracked[0].lastStatus,
      'the replacement is not complete; a resumed fold would have leaked the old completion',
    ).toBeUndefined();
  });

  it('preserves text whose multi-byte characters straddle a read boundary', async () => {
    // The trailing partial line is carried as BYTES, not as a decoded string,
    // because a read can stop in the middle of a UTF-8 character. Decoding
    // eagerly does not fail loudly -- the split bytes become U+FFFD, the line
    // still parses as JSON, and the corruption survives into the timeline as
    // mojibake. So this asserts on the recovered TEXT, not on parse success.
    const nickname = '侦察兵🚀scout';
    const spawn = spawnLine('2026-09-10T00:00:00.000Z');
    (spawn.payload as any).agent_nickname = nickname;
    const bytes = Buffer.from(JSON.stringify(spawn), 'utf8');

    // Cut two bytes into the 4-byte emoji: neither half is a valid character.
    const emojiStart = bytes.indexOf(Buffer.from('🚀', 'utf8'));
    expect(emojiStart).toBeGreaterThan(0);
    const cut = emojiStart + 2;

    await writeFile(rolloutPath, bytes.subarray(0, cut));
    const { provider } = makeProvider();
    const state = makeState();
    await scan(provider, state);
    expect(
      [...(provider as any).trackedSubagentThreads.keys()],
      'half a JSON line is not a record yet',
    ).toEqual([]);

    await writeFile(rolloutPath, Buffer.concat([bytes, Buffer.from('\n')]));
    await touchForward(rolloutPath);
    await scan(provider, state);

    const tracked = (provider as any).trackedSubagentThreads.get(AGENT_ID);
    expect(tracked, 'the completed line must be folded').toBeTruthy();
    expect(
      tracked.agentName,
      'the character split across the boundary must survive intact',
    ).toBe(nickname);
  });

  it('folds a final line that has no terminating newline yet', async () => {
    // Codex appends a record and its newline separately, so the last line is
    // routinely readable before it is terminated. The previous whole-file
    // `split` folded it; dropping it would delay every completion by a poll.
    const body = serialize([spawnLine('2026-09-10T00:00:00.000Z')]);
    const unterminated = JSON.stringify(completeLine('2026-09-10T00:01:00.000Z', 'done, no newline'));
    await writeFile(rolloutPath, body + unterminated, 'utf8');

    const { provider, emitted } = makeProvider();
    const state = makeState();
    await scan(provider, state);

    expect(emitted.at(-1)?.status).toEqual({ completed: 'done, no newline' });
  });
});
