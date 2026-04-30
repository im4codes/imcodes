/**
 * E2E regression test for daemon.upgrade gate.
 *
 * Pins the contract for two production failure modes that left users with a
 * daemon they could not upgrade except by running `imcodes service restart`
 * by hand:
 *
 *   1. Pre-3389fab2: a transport runtime that ratcheted to status='error'
 *      (codex-sdk refresh-token failure, qwen compression timeout) was
 *      treated by the gate as an active turn. Every server-dispatched
 *      `daemon.upgrade` bounced silently with "transport sessions have
 *      active turns", even though session.state was reported as 'idle' and
 *      the user had no in-flight work. This test reproduces the exact
 *      production scenario at the dispatch boundary (handleWebCommand →
 *      handleDaemonUpgrade) and asserts that 'error' MUST NOT block the
 *      upgrade.
 *
 *   2. The negative half of the contract: real in-flight work
 *      ('thinking' / 'streaming') and queued work (sending=true,
 *      pendingCount>0) MUST still block — otherwise an upgrade restart
 *      would silently drop a user's turn.
 *
 * The test drives `handleWebCommand({ type: 'daemon.upgrade' })` through
 * the real `command-handler.ts` dispatch table, with `getTransportRuntime`
 * stubbed to return synthetic runtimes. spawn() and fs writes are mocked
 * so the test never actually runs `npm install -g imcodes@latest` against
 * the host — but everything between WebCommand input and the spawn call
 * is real production code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAEMON_MSG } from '../../shared/daemon-events.js';

const mocks = vi.hoisted(() => {
  const store = new Map<string, Record<string, any>>();
  const runtimes = new Map<string, { getStatus: () => string; sending: boolean; pendingCount: number }>();
  const spawnCalls: Array<{ command: string; args: readonly string[] }> = [];
  const writeCalls: Array<{ path: string; data: string }> = [];
  return { store, runtimes, spawnCalls, writeCalls };
});

// ── Module mocks ──────────────────────────────────────────────────────────
//
// Match the shape used by sdk-transport-flow.test.ts so command-handler.ts
// can be imported without dragging in the full transport runtime chain.

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: vi.fn(() => [...mocks.store.values()]),
  getSession: vi.fn((name: string) => mocks.store.get(name) ?? null),
  upsertSession: vi.fn((record: Record<string, any>) => {
    if (record.name) mocks.store.set(record.name, record);
  }),
  removeSession: vi.fn((name: string) => { mocks.store.delete(name); }),
  updateSessionState: vi.fn(),
}));

vi.mock('../../src/agent/session-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agent/session-manager.js')>();
  return {
    ...actual,
    getTransportRuntime: vi.fn((name: string) => mocks.runtimes.get(name) ?? undefined),
  };
});

// spawn() is the smoking gun for "did the upgrade actually proceed?". If
// the gate doesn't block, handleDaemonUpgrade ends up calling
// spawn('wscript', ...) on Windows or spawn('/bin/bash', ...) on
// linux/darwin. We capture every spawn so the test can assert that the
// upgrade either started (gate passed) or didn't (gate blocked), without
// caring about platform.
function captureSpawn(command: string, args: readonly string[]) {
  mocks.spawnCalls.push({ command, args });
  return {
    unref: vi.fn(),
    on: vi.fn(),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
  } as any;
}

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn(captureSpawn) };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(captureSpawn) };
});

// fs writes are no-ops so the upgrade script doesn't pollute the host's
// temp dir on every test run. existsSync is left alone — the upgrade
// script branches on whether systemd / launchd / npm.cmd actually exist.
function captureWriteFileSync(path: any, data: any) {
  if (typeof path === 'string') mocks.writeCalls.push({ path, data: typeof data === 'string' ? data : data?.toString?.() ?? '' });
}

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn(captureWriteFileSync),
    mkdtempSync: vi.fn(() => '/tmp/imcodes-upgrade-gate-test'),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn(captureWriteFileSync),
    mkdtempSync: vi.fn(() => '/tmp/imcodes-upgrade-gate-test'),
  };
});

// ── Side-effect modules pulled in by command-handler.ts at load time ─────
// These are no-ops for our path; the daemon.upgrade dispatch never touches
// them, but they're required for module load to succeed.

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: {
    emit: vi.fn(),
    on: vi.fn(() => () => {}),
    epoch: 0,
    replay: vi.fn(() => ({ events: [], truncated: false })),
  },
}));

vi.mock('../../src/daemon/transport-history.js', () => ({
  appendTransportEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  listSessions: vi.fn().mockResolvedValue([]),
  newSession: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(undefined),
  sessionExists: vi.fn().mockResolvedValue(false),
  isPaneAlive: vi.fn().mockResolvedValue(false),
  respawnPane: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendKey: vi.fn().mockResolvedValue(undefined),
  sendKeysDelayedEnter: vi.fn().mockResolvedValue(undefined),
  sendRawInput: vi.fn().mockResolvedValue(undefined),
  resizeSession: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(''),
  showBuffer: vi.fn().mockResolvedValue(''),
  getPaneId: vi.fn().mockResolvedValue(undefined),
  getPaneCwd: vi.fn().mockResolvedValue(undefined),
  getPaneStartCommand: vi.fn().mockResolvedValue(''),
  cleanupOrphanFifos: vi.fn().mockResolvedValue(undefined),
  BACKEND: 'tmux',
}));

vi.mock('../../src/daemon/jsonl-watcher.js', () => ({
  startWatching: vi.fn(),
  startWatchingFile: vi.fn(),
  stopWatching: vi.fn(),
  isWatching: vi.fn(() => false),
  findJsonlPathBySessionId: vi.fn(),
}));

vi.mock('../../src/daemon/codex-watcher.js', () => ({
  startWatching: vi.fn(),
  startWatchingSpecificFile: vi.fn(),
  startWatchingById: vi.fn(),
  stopWatching: vi.fn(),
  isWatching: vi.fn(() => false),
  findRolloutPathByUuid: vi.fn(async () => null),
}));

vi.mock('../../src/daemon/gemini-watcher.js', () => ({
  startWatching: vi.fn(),
  startWatchingLatest: vi.fn(),
  stopWatching: vi.fn(),
  isWatching: vi.fn(() => false),
}));

vi.mock('../../src/daemon/opencode-watcher.js', () => ({
  startWatching: vi.fn(),
  stopWatching: vi.fn(),
  isWatching: vi.fn(() => false),
}));

vi.mock('../../src/agent/structured-session-bootstrap.js', () => ({
  resolveStructuredSessionBootstrap: vi.fn(async (x) => x),
}));

vi.mock('../../src/agent/agent-version.js', () => ({
  getAgentVersion: vi.fn().mockResolvedValue('test-version'),
}));

vi.mock('../../src/repo/cache.js', () => ({
  repoCache: { invalidate: vi.fn() },
}));

vi.mock('../../src/agent/signal.js', () => ({
  setupCCStopHook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/agent/notify-setup.js', () => ({
  setupCodexNotify: vi.fn().mockResolvedValue(undefined),
  setupOpenCodePlugin: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/agent/qwen-runtime-config.js', () => ({
  getQwenRuntimeConfig: vi.fn(async () => null),
}));

vi.mock('../../src/agent/codex-runtime-config.js', () => ({
  getCodexRuntimeConfig: vi.fn(async () => ({ planLabel: '', quotaLabel: '' })),
}));

vi.mock('../../src/agent/provider-display.js', () => ({
  getQwenDisplayMetadata: vi.fn(() => ({})),
}));

vi.mock('../../src/agent/provider-quota.js', () => ({
  getQwenOAuthQuotaUsageLabel: vi.fn(() => ''),
}));

vi.mock('../../src/agent/brain-dispatcher.js', () => ({
  BrainDispatcher: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

import { handleWebCommand } from '../../src/daemon/command-handler.js';

// ── Helpers ──────────────────────────────────────────────────────────────

const flushAsync = async () => {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => process.nextTick(resolve));
  // handleDaemonUpgrade does several `await import(...)` calls before the
  // gate's downstream effects are observable; macro-task tick lets those
  // dynamic imports settle even on slow CI.
  await new Promise((resolve) => setTimeout(resolve, 30));
};

async function waitForCondition(check: () => boolean, timeoutMs = 3000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for condition');
}

function addTransportSession(
  name: string,
  runtime: { status?: string; sending?: boolean; pendingCount?: number },
  overrides: Record<string, any> = {},
) {
  mocks.store.set(name, {
    name,
    projectName: name,
    role: 'brain',
    agentType: 'codex-sdk',
    projectDir: '/tmp/upgrade-gate-e2e',
    state: 'idle',
    runtimeType: 'transport',
    providerId: 'codex-sdk',
    providerSessionId: name,
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });
  mocks.runtimes.set(name, {
    getStatus: () => runtime.status ?? 'idle',
    sending: runtime.sending ?? false,
    pendingCount: runtime.pendingCount ?? 0,
  });
}

function getBlockedMessage(serverLink: { send: ReturnType<typeof vi.fn> }) {
  return serverLink.send.mock.calls
    .map((call) => call[0])
    .find((msg) => msg?.type === DAEMON_MSG.UPGRADE_BLOCKED);
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('daemon.upgrade gate (e2e regression for 3389fab2)', () => {
  beforeEach(() => {
    mocks.store.clear();
    mocks.runtimes.clear();
    mocks.spawnCalls.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── REGRESSION cases: stuck 'error' must NOT block ─────────────────────

  it("does NOT block daemon.upgrade when a single codex-sdk runtime is stuck in 'error' (production scenario)", async () => {
    // Reproduce the exact production failure mode:
    //   - codex-sdk refresh-token failed at 03:00
    //   - runtime.getStatus() ratcheted to 'error' and never recovered
    //   - session.state remained 'idle' (UI-level), so the user saw no in-flight work
    //   - every server-dispatched daemon.upgrade silently bounced for hours
    //
    // Pre-fix this assertion failed: blockedMessage was defined and
    // mocks.spawnCalls was empty.
    addTransportSession('deck_stuck_codex_brain', { status: 'error' });

    const serverLink = { send: vi.fn() } as { send: ReturnType<typeof vi.fn> };
    handleWebCommand({ type: 'daemon.upgrade' }, serverLink as any);
    await waitForCondition(() => mocks.spawnCalls.length > 0, 5000).catch(() => {});

    expect(getBlockedMessage(serverLink)).toBeUndefined();
    expect(mocks.spawnCalls.length).toBeGreaterThan(0);
  });

  it("does NOT block when both codex-sdk and qwen runtimes are simultaneously stuck in 'error'", async () => {
    // Real-world: a user with two transport sessions hit refresh-token
    // failures in both backends overnight. Pre-fix, both errored sessions
    // contributed to the gate count and the daemon was un-upgradable.
    addTransportSession('deck_stuck_codex_brain', { status: 'error' });
    addTransportSession(
      'deck_stuck_qwen_brain',
      { status: 'error' },
      { agentType: 'qwen', providerId: 'qwen' },
    );

    const serverLink = { send: vi.fn() } as { send: ReturnType<typeof vi.fn> };
    handleWebCommand({ type: 'daemon.upgrade' }, serverLink as any);
    await waitForCondition(() => mocks.spawnCalls.length > 0, 5000).catch(() => {});

    expect(getBlockedMessage(serverLink)).toBeUndefined();
    expect(mocks.spawnCalls.length).toBeGreaterThan(0);
  });

  it("does NOT block when one session is errored and another is idle", async () => {
    // The mixed-state case: an old errored session sticking around does
    // not become a permanent veto on upgrades for the rest of the daemon.
    addTransportSession('deck_errored_brain', { status: 'error' });
    addTransportSession('deck_idle_brain', { status: 'idle' });

    const serverLink = { send: vi.fn() } as { send: ReturnType<typeof vi.fn> };
    handleWebCommand({ type: 'daemon.upgrade' }, serverLink as any);
    await waitForCondition(() => mocks.spawnCalls.length > 0, 5000).catch(() => {});

    expect(getBlockedMessage(serverLink)).toBeUndefined();
    expect(mocks.spawnCalls.length).toBeGreaterThan(0);
  });

  // ── Real in-flight work must STILL block ───────────────────────────────

  it("blocks daemon.upgrade when a transport session is actually 'thinking'", async () => {
    // The contract's positive half: an upgrade restart while the user is
    // mid-turn would lose the response. The gate must still block here.
    addTransportSession('deck_thinking_brain', { status: 'thinking' });

    const serverLink = { send: vi.fn() } as { send: ReturnType<typeof vi.fn> };
    handleWebCommand({ type: 'daemon.upgrade' }, serverLink as any);
    await flushAsync();

    expect(getBlockedMessage(serverLink)).toMatchObject({
      type: DAEMON_MSG.UPGRADE_BLOCKED,
      reason: 'transport_busy',
      activeSessionNames: ['deck_thinking_brain'],
      blockedSessions: [
        {
          name: 'deck_thinking_brain',
          sessionState: 'idle',
          runtime: {
            status: 'thinking',
            sending: false,
            pendingCount: 0,
            blockReason: 'status_thinking',
          },
        },
      ],
    });
    expect(mocks.spawnCalls).toEqual([]);
  });

  it("blocks daemon.upgrade when a transport session is 'streaming'", async () => {
    addTransportSession('deck_streaming_brain', { status: 'streaming' });

    const serverLink = { send: vi.fn() } as { send: ReturnType<typeof vi.fn> };
    handleWebCommand({ type: 'daemon.upgrade' }, serverLink as any);
    await flushAsync();

    expect(getBlockedMessage(serverLink)).toMatchObject({
      type: DAEMON_MSG.UPGRADE_BLOCKED,
      reason: 'transport_busy',
      activeSessionNames: ['deck_streaming_brain'],
    });
    expect(mocks.spawnCalls).toEqual([]);
  });

  it("blocks daemon.upgrade when sending=true even if status is idle (real send dispatching)", async () => {
    // sending=true means the runtime is mid-await on the provider's
    // send() — restarting drops the request. Still blocks.
    addTransportSession('deck_sending_brain', { status: 'idle', sending: true });

    const serverLink = { send: vi.fn() } as { send: ReturnType<typeof vi.fn> };
    handleWebCommand({ type: 'daemon.upgrade' }, serverLink as any);
    await flushAsync();

    expect(getBlockedMessage(serverLink)).toMatchObject({
      type: DAEMON_MSG.UPGRADE_BLOCKED,
      reason: 'transport_busy',
      activeSessionNames: ['deck_sending_brain'],
    });
    expect(mocks.spawnCalls).toEqual([]);
  });

  it("blocks daemon.upgrade when pendingCount > 0 even if status is idle (queued user messages)", async () => {
    // Pending messages would be lost on restart. Still blocks.
    addTransportSession('deck_queued_brain', { status: 'idle', pendingCount: 2 });

    const serverLink = { send: vi.fn() } as { send: ReturnType<typeof vi.fn> };
    handleWebCommand({ type: 'daemon.upgrade' }, serverLink as any);
    await flushAsync();

    expect(getBlockedMessage(serverLink)).toMatchObject({
      type: DAEMON_MSG.UPGRADE_BLOCKED,
      reason: 'transport_busy',
      activeSessionNames: ['deck_queued_brain'],
    });
    expect(mocks.spawnCalls).toEqual([]);
  });

  // ── Mixed state: real work blocks even when other sessions are stuck ───

  it("still blocks when one session is 'thinking' and another is stuck 'error' (don't lose work)", async () => {
    // Important: a stuck-error session does not exempt a daemon with
    // genuinely active work elsewhere. The gate filters out 'error' but
    // still reports the busy session.
    addTransportSession('deck_busy_brain', { status: 'thinking' });
    addTransportSession('deck_stuck_brain', { status: 'error' });

    const serverLink = { send: vi.fn() } as { send: ReturnType<typeof vi.fn> };
    handleWebCommand({ type: 'daemon.upgrade' }, serverLink as any);
    await flushAsync();

    const blocked = getBlockedMessage(serverLink);
    expect(blocked).toBeDefined();
    expect(blocked?.activeSessionNames).toContain('deck_busy_brain');
    expect(blocked?.activeSessionNames).not.toContain('deck_stuck_brain');
    expect(mocks.spawnCalls).toEqual([]);
  });

  // ── Empty-state baseline: a clean daemon proceeds ──────────────────────

  it("proceeds with no transport sessions and no P2P runs", async () => {
    const serverLink = { send: vi.fn() } as { send: ReturnType<typeof vi.fn> };
    handleWebCommand({ type: 'daemon.upgrade' }, serverLink as any);
    await waitForCondition(() => mocks.spawnCalls.length > 0, 5000).catch(() => {});

    expect(getBlockedMessage(serverLink)).toBeUndefined();
    expect(mocks.spawnCalls.length).toBeGreaterThan(0);
  });

  it("proceeds when a transport session exists but the runtime has been disposed (getTransportRuntime returns undefined)", async () => {
    // Production edge case: a session record exists in the store but its
    // runtime was disposed (e.g. mid-shutdown, mid-restart). The gate
    // must not treat "no runtime" as "active turn" — that would also
    // forever-block upgrades.
    mocks.store.set('deck_no_runtime_brain', {
      name: 'deck_no_runtime_brain',
      projectName: 'deck_no_runtime_brain',
      role: 'brain',
      agentType: 'codex-sdk',
      projectDir: '/tmp/upgrade-gate-e2e',
      state: 'idle',
      runtimeType: 'transport',
      providerId: 'codex-sdk',
      providerSessionId: 'deck_no_runtime_brain',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
    });
    // No runtime registered for this session name.

    const serverLink = { send: vi.fn() } as { send: ReturnType<typeof vi.fn> };
    handleWebCommand({ type: 'daemon.upgrade' }, serverLink as any);
    await waitForCondition(() => mocks.spawnCalls.length > 0, 5000).catch(() => {});

    expect(getBlockedMessage(serverLink)).toBeUndefined();
    expect(mocks.spawnCalls.length).toBeGreaterThan(0);
  });
});

// ── Generated upgrade.sh contract (Linux/macOS) ─────────────────────────
//
// Captured production failure on 116.62.239.78 (2026-04-27 23:46): the
// server published `imcodes@2026.4.1951-dev.1930` to npm and broadcast
// `daemon.upgrade { targetVersion }` immediately. The daemon's upgrade
// script ran `npm install -g imcodes@<that version>`, npm hit a regional
// CDN edge that hadn't replicated yet, returned a packument missing the
// new version, and exited with ETARGET. The script then logged
// `install FAILED (exit 0)` (wrong — npm exited 1 but `! cmd` mangled
// `$?`) and aborted with no retry. One bad broadcast = a missed upgrade
// for that release until the server broadcasts again.
//
// These tests pin the post-fix contract for the bash branch:
//   1. Real install exit code is captured (no more "(exit 0)" lie).
//   2. ETARGET retries 4× with 30/60/120s back-off + cache-clean.
//   3. Non-ETARGET errors fail-fast and tail the npm output into the log.
//   4. Generated bash is syntactically valid.
//
// Skipped on Windows because that branch returns early — see the
// `if (process.platform === 'win32')` block in handleDaemonUpgrade.
const skipOnWindows = process.platform === 'win32' ? describe.skip : describe;

skipOnWindows('daemon.upgrade — Linux/macOS upgrade.sh contract', () => {
  beforeEach(() => {
    mocks.store.clear();
    mocks.runtimes.clear();
    mocks.spawnCalls.length = 0;
    mocks.writeCalls.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function captureUpgradeScript(): Promise<string> {
    const serverLink = { send: vi.fn() } as { send: ReturnType<typeof vi.fn> };
    handleWebCommand({ type: 'daemon.upgrade', targetVersion: '99.99.99-test' } as any, serverLink as any);
    await waitForCondition(
      () => mocks.writeCalls.some((c) => c.path.endsWith('upgrade.sh')),
      5000,
    );
    const script = mocks.writeCalls.find((c) => c.path.endsWith('upgrade.sh'));
    if (!script) throw new Error('upgrade.sh was never written');
    return script.data;
  }

  it('captures the real install exit code (regression: pre-fix logged "(exit 0)" on every failure)', async () => {
    const sh = await captureUpgradeScript();
    // Pre-fix used `if ! eval "$NPM_RUN install ..." ; then log "[step 2] install FAILED (exit $?)"`,
    // where $? after the `!` inversion is always 0. Post-fix captures
    // INSTALL_RC=$? on its own line so the logged code is real.
    expect(sh).toMatch(/INSTALL_RC=\$\?/);
    expect(sh).not.toMatch(/install FAILED \(exit \$\?\) — keeping current daemon running/);
  });

  it('retries up to 4 times on ETARGET with packument cache-clean between attempts', async () => {
    const sh = await captureUpgradeScript();
    // Loop bounded by MAX_ATTEMPTS=4 with explicit per-attempt back-off.
    // 60/180/300s = 1m/3m/5m — the 5-min last gap is the deliberately
    // wide window: a real production CDN edge took >2m to replicate
    // and the previous 120s ceiling missed it.
    expect(sh).toMatch(/MAX_ATTEMPTS=4/);
    expect(sh).toMatch(/RETRY_DELAYS=\(0 60 180 300\)/);
    // ETARGET detection is the trigger; non-ETARGET must NOT retry.
    expect(sh).toMatch(/grep -qiE 'code ETARGET\|No matching version found'/);
    // Cache-clean between attempts so npm refetches origin instead of
    // revalidating into the stale cached 200.
    expect(sh).toMatch(/cache clean --force/);
    // --prefer-online forces revalidation on the first attempt too.
    expect(sh).toMatch(/install -g --ignore-scripts --prefer-online/);
  });

  it('non-ETARGET failures bail after 1 attempt and tail npm output into the log', async () => {
    const sh = await captureUpgradeScript();
    // The non-ETARGET branch must `break` out of the retry loop AND
    // surface the npm error tail prefixed into upgrade.log so operators
    // can diagnose without re-reading the giant per-attempt file.
    expect(sh).toMatch(/non-ETARGET failure — not retrying/);
    expect(sh).toMatch(/tail -20 "\$INSTALL_OUT"/);
  });

  it('uses an atomic single-flight lock before touching the global npm install', async () => {
    const sh = await captureUpgradeScript();

    const lockIdx = sh.indexOf('if mkdir "$UPGRADE_LOCK_DIR"');
    const installIdx = sh.indexOf('install -g --ignore-scripts --prefer-online');
    const restartIdx = sh.indexOf('log "[step 4] running restart command"');

    expect(sh).toContain('UPGRADE_LOCK_DIR="$HOME/.imcodes/upgrade.lock.d"');
    expect(sh).toContain('another upgrade is already running');
    expect(sh).toContain('trap release_upgrade_lock EXIT');
    expect(sh).toContain('mv "$UPGRADE_LOCK_DIR" "$STALE_LOCK"');
    expect(lockIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeGreaterThan(-1);
    expect(restartIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeLessThan(installIdx);
    expect(lockIdx).toBeLessThan(restartIdx);
  });

  it('generated bash is syntactically valid (`bash -n` passes)', async () => {
    const sh = await captureUpgradeScript();
    // Use vi.importActual to bypass the fs mock above (which captures
    // writes into mocks.writeCalls instead of hitting disk) and the
    // child_process mock (which captures spawn calls). bash -n needs
    // the real script on disk and a real spawn to validate it.
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const realCp = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = realFs.mkdtempSync(join(tmpdir(), 'imcodes-bashcheck-'));
    const path = join(dir, 'upgrade.sh');
    try {
      realFs.writeFileSync(path, sh);
      const res = realCp.spawnSync('bash', ['-n', path], { encoding: 'utf8' });
      if (res.status !== 0) {
        throw new Error(`bash -n exited ${res.status}\nstderr:\n${res.stderr}`);
      }
      expect(res.status).toBe(0);
    } finally {
      realFs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
