/**
 * Tests for Qwen provider cancel behavior:
 * - SIGKILL escalation after SIGTERM timeout
 * - Session reset after cancel (next send starts fresh conversation)
 * - qwenConversationId regeneration prevents resuming stuck tool-call loops
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

// ── Mock child_process ────────────────────────────────────────────────────
let spawnedChildren: MockChild[] = [];

class MockChild extends EventEmitter {
  killed = false;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  private signals: string[] = [];

  kill(signal?: string): boolean {
    this.signals.push(signal ?? 'SIGTERM');
    if (signal === 'SIGKILL') {
      this.killed = true;
      // SIGKILL always works — schedule close
      setTimeout(() => this.emit('close', null, 'SIGKILL'), 0);
    }
    return true;
  }

  /** Simulate process starting */
  start(): void {
    this.emit('spawn');
  }

  /** Simulate process exiting */
  exit(code: number | null = 0, signal: string | null = null): void {
    this.killed = true;
    this.emit('close', code, signal);
  }

  getSignals(): string[] {
    return [...this.signals];
  }
}

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const child = new MockChild();
    spawnedChildren.push(child);
    // Auto-start after a tick
    setTimeout(() => child.start(), 0);
    return child;
  }),
  execFile: vi.fn((..._args: unknown[]) => {
    const cb = (typeof _args[2] === 'function' ? _args[2] : _args[3]) as
      | ((err: null, stdout: string) => void)
      | undefined;
    cb?.(null, 'qwen-code version 1.0.0');
  }),
}));

vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/util/model-context.js', () => ({
  inferContextWindow: vi.fn(() => 1_000_000),
}));

// Import after mocks
const { QwenProvider } = await import('../../src/agent/providers/qwen.js');

const flushAsync = () => new Promise<void>((r) => setTimeout(r, 50));

async function waitForSpawn(index: number): Promise<MockChild> {
  for (let i = 0; i < 10; i += 1) {
    const child = spawnedChildren[index];
    if (child) return child;
    await flushAsync();
  }
  throw new Error(`Spawned child ${index} not found`);
}

describe('Qwen provider cancel', () => {
  let provider: InstanceType<typeof QwenProvider>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    spawnedChildren = [];
    provider = new QwenProvider();
    await provider.connect({});
  });

  afterEach(async () => {
    vi.useRealTimers();
    try { await provider.disconnect(); } catch { /* */ }
    vi.restoreAllMocks();
  });

  it('sends SIGTERM on cancel', async () => {
    const sessionId = await provider.createSession({ sessionKey: 'test-1', cwd: '/tmp' });

    // Start a send (don't await — it waits for process to finish)
    const sendPromise = provider.send(sessionId, 'hello').catch(() => {});
    const child = await waitForSpawn(0);

    await provider.cancel(sessionId);
    expect(child.getSignals()).toContain('SIGTERM');

    // Clean up
    child.exit(null, 'SIGTERM');
    await sendPromise;
  });

  it('escalates to SIGKILL after 2 seconds if SIGTERM is ignored', async () => {
    const sessionId = await provider.createSession({ sessionKey: 'test-2', cwd: '/tmp' });

    const sendPromise = provider.send(sessionId, 'hello').catch(() => {});
    const child = await waitForSpawn(0);

    await provider.cancel(sessionId);
    expect(child.getSignals()).toEqual(['SIGTERM']);

    // Process ignores SIGTERM — advance past the 2s escalation
    await vi.advanceTimersByTimeAsync(2100);

    expect(child.getSignals()).toContain('SIGKILL');

    await sendPromise;
  });

  it('does not SIGKILL if process exits before 2s timeout', async () => {
    const sessionId = await provider.createSession({ sessionKey: 'test-3', cwd: '/tmp' });

    const sendPromise = provider.send(sessionId, 'hello').catch(() => {});
    const child = await waitForSpawn(0);

    await provider.cancel(sessionId);
    expect(child.getSignals()).toEqual(['SIGTERM']);

    // Process exits gracefully within 2s
    child.exit(null, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(2100);

    // Only SIGTERM was sent — no SIGKILL
    expect(child.getSignals()).toEqual(['SIGTERM']);

    await sendPromise;
  });

  it('resets started flag after cancel so next send starts fresh', async () => {
    const sessionId = await provider.createSession({ sessionKey: 'test-4', cwd: '/tmp' });

    // First send — establishes session
    const sendPromise1 = provider.send(sessionId, 'first message').catch(() => {});
    const child1 = await waitForSpawn(0);
    // Simulate successful completion via stdout
    child1.stdout.emit('data', JSON.stringify({ type: 'system', subtype: 'session_start' }) + '\n');
    child1.stdout.emit('data', JSON.stringify({ type: 'result', result: 'done' }) + '\n');
    child1.exit(0);
    await sendPromise1;

    // Session is now started — next send would normally use --resume
    // Now cancel
    const sendPromise2 = provider.send(sessionId, 'trigger loop').catch(() => {});
    const child2 = await waitForSpawn(1);
    await provider.cancel(sessionId);
    child2.exit(null, 'SIGTERM');
    await sendPromise2;

    // Next send should use --session-id (fresh) not --resume
    const sendPromise3 = provider.send(sessionId, 'after cancel').catch(() => {});
    const child3 = await waitForSpawn(2);
    const { spawn: spawnMock } = await import('node:child_process');
    const lastCall = vi.mocked(spawnMock).mock.calls[2];
    const args = lastCall[1] as string[];

    // Must have --session-id (fresh), NOT --resume
    expect(args).toContain('--session-id');
    expect(args).not.toContain('--resume');

    // The conversation ID must be different from the original session ID
    const sessionIdIdx = args.indexOf('--session-id');
    const conversationId = args[sessionIdIdx + 1];
    expect(conversationId).not.toBe(sessionId);

    child3.exit(0);
    await sendPromise3;
  });
});
