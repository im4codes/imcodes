/**
 * claude-code-sdk is the one provider with a real pre-tool hook, so a pair
 * participant's git write in the main checkout is refused BEFORE it runs
 * (tsk_cd_reassigned_executor_workspace). The guard is the daemon's decision;
 * the provider only carries it out and must never break a tool call.
 */
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const childProcessMock = vi.hoisted(() => ({
  execFile: vi.fn((..._args: unknown[]) => {
    const cb = (typeof _args[2] === 'function' ? _args[2] : _args[3]) as ((err: Error | null, stdout: string, stderr: string) => void) | undefined;
    cb?.(null, 'ok\n', '');
    return {} as never;
  }),
  spawn: vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & { killed: boolean; kill: (signal?: NodeJS.Signals) => boolean };
    child.killed = false;
    child.kill = vi.fn(() => true) as never;
    return child;
  }) as never,
}));
vi.mock('node:child_process', () => ({ execFile: childProcessMock.execFile, spawn: childProcessMock.spawn }));

const sdkMock = vi.hoisted(() => {
  const runs: Array<{ options: Record<string, unknown> }> = [];
  const query = vi.fn(({ options }: { prompt: unknown; options: Record<string, unknown> }) => {
    runs.push({ options });
    async function* gen() { /* no messages */ }
    const iterator = gen() as AsyncGenerator<unknown, void> & { close(): void; interrupt(): Promise<void>; stopTask(taskId: string): Promise<void>; getContextUsage(): Promise<object> };
    iterator.close = () => {}; iterator.interrupt = async () => {}; iterator.stopTask = async () => {}; iterator.getContextUsage = async () => ({});
    return iterator;
  });
  return { query, runs };
});
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdkMock.query }));
const loggerMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/util/logger.js', () => ({ default: loggerMock }));

import { ClaudeCodeSdkProvider } from '../../src/agent/providers/claude-code-sdk.js';
import type { ToolExecutionGuard } from '../../src/agent/transport-provider.js';

type HookFn = (input: unknown, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<Record<string, unknown>>;
const signal = new AbortController().signal;

async function startProvider(guard?: ToolExecutionGuard) {
  const provider = new ClaudeCodeSdkProvider();
  if (guard) provider.setToolExecutionGuard(guard);
  await provider.connect({ binaryPath: 'claude' });
  await provider.createSession({ sessionKey: 'route-exec', sessionName: 'deck_sub_exec', cwd: '/project' });
  void provider.send('route-exec', 'work').catch(() => {});
  const deadline = Date.now() + 1_000;
  while (sdkMock.runs.length < 1) {
    if (Date.now() > deadline) throw new Error('provider did not start a run');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const matchers = (sdkMock.runs[0]!.options.hooks as { PreToolUse?: Array<{ matcher?: string; hooks: HookFn[] }> }).PreToolUse ?? [];
  return matchers.find((entry) => entry.matcher === 'Bash')!.hooks[0]!;
}
const bashInput = (command: string, cwd = '/project') => ({
  hook_event_name: 'PreToolUse', session_id: 's', transcript_path: '/t', cwd, tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_1',
});

describe('Claude SDK Bash tool-execution guard', () => {
  beforeEach(() => {
    sdkMock.query.mockClear();
    sdkMock.runs.length = 0;
    loggerMock.warn.mockClear();
  });

  it('refuses the call with a deny decision carrying the daemon reason, and hands the guard the route, tool, input and cwd', async () => {
    const guard = vi.fn<ToolExecutionGuard>(() => ({ allow: false, reason: 'main checkout is off limits' }));
    const hook = await startProvider(guard);
    const output = await hook(bashInput('git reset --hard origin/dev', '/project'), 'toolu_1', { signal });
    expect(output).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'main checkout is off limits' } });
    expect(guard).toHaveBeenCalledExactlyOnceWith('route-exec', { toolName: 'Bash', input: { command: 'git reset --hard origin/dev' }, cwd: '/project', toolUseId: 'toolu_1' });
  });

  it('allows the call when the guard allows, when no guard is installed, and for a non-PreToolUse event', async () => {
    const hook = await startProvider(() => ({ allow: true }));
    await expect(hook(bashInput('git status'), 'toolu_1', { signal })).resolves.toEqual({});
    await expect(hook({ ...bashInput('git status'), hook_event_name: 'PostToolUse' }, 'toolu_1', { signal })).resolves.toEqual({});
    sdkMock.runs.length = 0;
    const noGuard = await startProvider();
    await expect(noGuard(bashInput('git reset --hard'), 'toolu_1', { signal })).resolves.toEqual({});
  });

  it('a guard that throws never breaks the tool call: it is allowed and the failure is logged', async () => {
    const hook = await startProvider(() => { throw new Error('boom'); });
    await expect(hook(bashInput('git reset --hard'), 'toolu_1', { signal })).resolves.toEqual({});
    expect(loggerMock.warn).toHaveBeenCalled();
  });
});
