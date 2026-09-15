import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const childProcessMock = vi.hoisted(() => ({
  execFile: vi.fn((..._args: unknown[]) => {
    const cb = (typeof _args[2] === 'function' ? _args[2] : _args[3]) as
      | ((err: Error | null, stdout: string, stderr: string) => void)
      | undefined;
    cb?.(null, 'ok\n', '');
    return {} as never;
  }),
  spawn: vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & { killed: boolean; kill: (signal?: NodeJS.Signals) => boolean };
    child.killed = false;
    child.kill = vi.fn((signal?: NodeJS.Signals) => {
      child.killed = true;
      setImmediate(() => child.emit('exit', null, signal ?? 'SIGTERM'));
      return true;
    }) as never;
    return child;
  }) as never,
}));

vi.mock('node:child_process', () => ({
  execFile: childProcessMock.execFile,
  spawn: childProcessMock.spawn,
}));

const sdkMock = vi.hoisted(() => {
  const runs: Array<{ options: Record<string, unknown> }> = [];
  const query = vi.fn(({ options }: { prompt: unknown; options: Record<string, unknown> }) => {
    runs.push({ options });
    async function* gen() { /* no messages */ }
    const iterator = gen() as AsyncGenerator<unknown, void> & {
      close(): void; interrupt(): Promise<void>; stopTask(taskId: string): Promise<void>; getContextUsage(): Promise<object>;
    };
    iterator.close = () => {};
    iterator.interrupt = async () => {};
    iterator.stopTask = async () => {};
    iterator.getContextUsage = async () => ({});
    return iterator;
  });
  return { query, runs };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdkMock.query }));

const loggerMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/util/logger.js', () => ({ default: loggerMock }));

import { ClaudeCodeSdkProvider } from '../../src/agent/providers/claude-code-sdk.js';
import {
  NATIVE_COLLABORATION_POLICY_NOTICE_MARKER,
  type NativeCollaborationGate,
} from '../../shared/native-collaboration-policy.js';

type HookFn = (input: unknown, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<Record<string, unknown>>;

const waitFor = async (predicate: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

async function startProvider(gate?: NativeCollaborationGate) {
  const provider = new ClaudeCodeSdkProvider();
  if (gate) provider.setNativeCollaborationGate(gate);
  await provider.connect({ binaryPath: 'claude' });
  await provider.createSession({ sessionKey: 'route-brain', sessionName: 'deck_project_brain', cwd: '/tmp/project' });
  void provider.send('route-brain', 'coordinate the project').catch(() => {});
  await waitFor(() => sdkMock.runs.length === 1);
  const options = sdkMock.runs[0]!.options;
  const matchers = (options.hooks as { PreToolUse?: Array<{ matcher?: string; hooks: HookFn[] }> } | undefined)?.PreToolUse ?? [];
  return { provider, options, matchers, hook: matchers[0]?.hooks[0] };
}

const hookInput = (toolName: string, toolInput: Record<string, unknown>) => ({
  hook_event_name: 'PreToolUse',
  session_id: 'claude-session',
  transcript_path: '/tmp/transcript.jsonl',
  cwd: '/tmp/project',
  tool_name: toolName,
  tool_input: toolInput,
  tool_use_id: 'toolu_native_1',
});

const signal = new AbortController().signal;

describe('Claude SDK native collaboration pre-execution gate', () => {
  beforeEach(() => {
    sdkMock.query.mockClear();
    sdkMock.runs.length = 0;
    loggerMock.warn.mockClear();
  });

  it('keeps native agent tools available and routes every one through one PreToolUse gate', async () => {
    const { provider, options, matchers, hook } = await startProvider(() => ({ allow: true }));
    expect(provider.capabilities.nativeAgentAdmission).toBe('pre_execution_gate');
    // Not hidden, not disabled: only native scheduling tools stay disallowed.
    expect(options.disallowedTools).not.toContain('Agent');
    expect(options.disallowedTools).not.toContain('Task');
    expect(matchers).toHaveLength(1);
    expect(matchers[0]!.matcher).toBe('Agent|Task|Workflow|SendMessage');
    expect(typeof hook).toBe('function');
  });

  it('gates workflow orchestration and follow-up messages with every request string they carry', async () => {
    const gate = vi.fn<NativeCollaborationGate>(() => ({ allow: true }));
    const { hook } = await startProvider(gate);
    await hook!(hookInput('Workflow', { script: 'agent("fix the build")', args: { goal: 'ship it' } }), 'toolu_w', { signal });
    await hook!(hookInput('SendMessage', { to: 'helper', message: 'now push the branch' }), 'toolu_s', { signal });
    expect(gate.mock.calls.map(([, request]) => [request.toolName, request.requestText])).toEqual([
      ['Workflow', 'agent("fix the build")\nship it'],
      ['SendMessage', 'now push the branch'],
    ]);
  });

  it('refuses Brain task participation before execution with the full request and an IM.codes reroute reason', async () => {
    const gate = vi.fn<NativeCollaborationGate>(() => ({
      allow: false,
      reason: '<imcodes-native-collaboration-policy-v1>\nreroute through send_message with task',
      signals: ['implementation'],
    }));
    const { hook } = await startProvider(gate);
    const longPrompt = `${'context '.repeat(80)}Please implement the retry queue and git push the branch.`;

    const output = await hook!(hookInput('Agent', { description: 'Queue work', prompt: longPrompt, subagent_type: 'general-purpose' }), 'toolu_native_1', { signal });

    expect(gate).toHaveBeenCalledExactlyOnceWith('route-brain', {
      provider: 'claude-code-sdk',
      toolName: 'Agent',
      requestText: `Queue work\n${longPrompt}`,
      toolUseId: 'toolu_native_1',
    });
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: '<imcodes-native-collaboration-policy-v1>\nreroute through send_message with task',
      },
    });
  });

  it('allows analysis requests, other tools, and sessions without an IM.codes gate', async () => {
    const allowGate = vi.fn<NativeCollaborationGate>(() => ({ allow: true }));
    const { hook } = await startProvider(allowGate);
    await expect(hook!(hookInput('Task', { description: 'Explore', prompt: 'Summarize the restore path' }), 'toolu_a', { signal }))
      .resolves.toEqual({});
    expect(allowGate).toHaveBeenCalledOnce();

    allowGate.mockClear();
    await expect(hook!(hookInput('Bash', { command: 'git push' }), 'toolu_b', { signal })).resolves.toEqual({});
    await expect(hook!({ hook_event_name: 'PostToolUse', tool_name: 'Agent' }, 'toolu_c', { signal })).resolves.toEqual({});
    expect(allowGate).not.toHaveBeenCalled();

    // Outside IM.codes no gate is installed: native collaboration is untouched.
    sdkMock.runs.length = 0;
    const noGate = await startProvider();
    await expect(noGate.hook!(hookInput('Agent', { prompt: 'Implement it' }), 'toolu_d', { signal })).resolves.toEqual({});
  });

  it('fails closed when the installed gate cannot answer', async () => {
    // The relay skips post-start correction for pre-execution providers, so an
    // allow-on-error here would leave Brain task work with no enforcement.
    const failing = await startProvider(() => { throw new Error('registry offline'); });
    const output = await failing.hook!(hookInput('Agent', { prompt: 'Implement it' }), 'toolu_e', { signal });
    const hookOutput = (output as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput;
    expect(hookOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    const reason = String(hookOutput?.permissionDecisionReason);
    expect(reason.startsWith(NATIVE_COLLABORATION_POLICY_NOTICE_MARKER)).toBe(true);
    expect(JSON.parse(reason.slice(reason.indexOf('{')))).toMatchObject({
      outcome: 'native_agent_request_denied_policy_unavailable',
      provider: 'claude-code-sdk',
      tool: 'Agent',
    });
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'claude-code-sdk' }),
      'Claude SDK native collaboration gate failed; denying tool',
    );
  });
});
