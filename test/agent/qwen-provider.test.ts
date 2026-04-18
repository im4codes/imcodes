import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const childProcessMock = vi.hoisted(() => {
  // execFile may be called with (file, args, cb) or (file, args, opts, cb)
  const execFile = vi.fn((...callArgs: unknown[]) => {
    const file = callArgs[0] as string;
    const args = callArgs[1] as string[];
    const cb = (typeof callArgs[2] === 'function' ? callArgs[2] : callArgs[3]) as
      | ((err: Error | null, stdout: string, stderr: string) => void)
      | undefined;
    // Match either bare 'qwen' or a resolved node + cli.js path
    const isVersionCall = (file === 'qwen' || file.toLowerCase().endsWith('node.exe') || file.toLowerCase().endsWith('node'))
      && args.includes('--version');
    cb?.(null, isVersionCall ? '0.13.2\n' : '', '');
    return {} as never;
  });

  const spawned: Array<{
    file: string;
    args: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    child: EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
      killed: boolean;
    };
  }> = [];

  const spawn = vi.fn((file: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
      killed: boolean;
    };
    child.stdout = stdout;
    child.stderr = stderr;
    child.killed = false;
    child.kill = vi.fn(() => { child.killed = true; child.emit('close', null, 'SIGTERM'); return true; });
    spawned.push({ file, args, cwd: opts.cwd, env: opts.env, child });
    queueMicrotask(() => child.emit('spawn'));
    return child as never;
  });

  return { execFile, spawn, spawned };
});

vi.mock('node:child_process', () => ({
  execFile: childProcessMock.execFile,
  spawn: childProcessMock.spawn,
}));

vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { QwenProvider } from '../../src/agent/providers/qwen.js';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import type { ToolCallEvent } from '../../src/agent/transport-provider.js';
import type { ProviderContextPayload } from '../../shared/context-types.js';

function lastSpawn() {
  const entry = childProcessMock.spawned.at(-1);
  if (!entry) throw new Error('No spawned qwen process');
  return entry;
}

async function flushIO(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForSpawnCount(count: number): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (childProcessMock.spawn.mock.calls.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${count} qwen spawns`);
}

describe('QwenProvider', () => {
  beforeEach(() => {
    childProcessMock.execFile.mockClear();
    childProcessMock.spawn.mockClear();
    childProcessMock.spawned.length = 0;
  });

  it('connects by validating qwen CLI', async () => {
    const provider = new QwenProvider();
    await provider.connect({});
    // execFile signature is (file, args, opts, cb) — opts contains windowsHide
    const call = childProcessMock.execFile.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('--version'),
    );
    expect(call).toBeDefined();
    expect(call?.[1]).toContain('--version');
    expect(provider.capabilities.reasoningEffort).toBe(true);
    expect(provider.capabilities.supportedEffortLevels).toEqual(['off', 'low', 'medium', 'high']);
  });

  it('writes qwen reasoning settings and switches them per session effort', async () => {
    const provider = new QwenProvider();
    await provider.connect({});
    await provider.createSession({
      sessionKey: 'sess-effort',
      cwd: '/tmp/project',
      effort: 'low',
    });

    await provider.send('sess-effort', 'hello');
    const first = lastSpawn();
    const firstSettingsPath = first.env?.QWEN_CODE_SYSTEM_SETTINGS_PATH;
    expect(typeof firstSettingsPath).toBe('string');
    expect(JSON.parse(await readFile(String(firstSettingsPath), 'utf8'))).toEqual({
      model: { generationConfig: { reasoning: { effort: 'low' } } },
    });

    first.child.stdout.write(`${JSON.stringify({ type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: 'Hello' }] } })}\n`);
    first.child.emit('close', 0, null);
    await flushIO();

    await provider.setSessionEffort('sess-effort', 'off');
    await provider.send('sess-effort', 'again');
    const second = lastSpawn();
    const secondSettingsPath = second.env?.QWEN_CODE_SYSTEM_SETTINGS_PATH;
    expect(secondSettingsPath).toBe(firstSettingsPath);
    expect(JSON.parse(await readFile(String(secondSettingsPath), 'utf8'))).toEqual({
      model: { generationConfig: { reasoning: false } },
    });
  });

  it('merges provided qwen settings with reasoning settings', async () => {
    const provider = new QwenProvider();
    await provider.connect({});
    await provider.createSession({
      sessionKey: 'sess-preset',
      cwd: '/tmp/project',
      effort: 'high',
      agentId: 'MiniMax-M2.7',
      settings: {
        security: { auth: { selectedType: 'anthropic' } },
        model: { name: 'MiniMax-M2.7' },
        modelProviders: {
          anthropic: [
            {
              id: 'MiniMax-M2.7',
              envKey: 'ANTHROPIC_API_KEY',
              baseUrl: 'https://api.minimax.io/anthropic',
            },
          ],
        },
      },
    });

    await provider.send('sess-preset', 'hello');
    const first = lastSpawn();
    const settingsPath = first.env?.QWEN_CODE_SYSTEM_SETTINGS_PATH;
    expect(typeof settingsPath).toBe('string');
    expect(JSON.parse(await readFile(String(settingsPath), 'utf8'))).toEqual({
      security: { auth: { selectedType: 'anthropic' } },
      model: {
        name: 'MiniMax-M2.7',
        generationConfig: { reasoning: { effort: 'high' } },
      },
      modelProviders: {
        anthropic: [
          {
            id: 'MiniMax-M2.7',
            envKey: 'ANTHROPIC_API_KEY',
            baseUrl: 'https://api.minimax.io/anthropic',
          },
        ],
      },
    });
    // --auth-type must be passed so qwen CLI doesn't fall back to user-level
    // ~/.qwen/settings.json (which commonly pins selectedType: qwen-oauth).
    const authTypeIndex = first.args.indexOf('--auth-type');
    expect(authTypeIndex).toBeGreaterThan(-1);
    expect(first.args[authTypeIndex + 1]).toBe('anthropic');
  });

  it('omits --auth-type when no preset settings are provided (preserves default qwen auth)', async () => {
    const provider = new QwenProvider();
    await provider.connect({});
    await provider.createSession({
      sessionKey: 'sess-no-preset',
      cwd: '/tmp/project',
      effort: 'medium',
    });

    await provider.send('sess-no-preset', 'hello');
    const spawned = lastSpawn();
    // Users without a preset rely on `qwen auth` (coding-plan / api-key / OAuth
    // choice stored in ~/.qwen/settings.json) — we must not force an auth tier
    // for them, or we'd override their working configuration.
    expect(spawned.args.includes('--auth-type')).toBe(false);
  });

  it('ignores settings.security.auth.selectedType that qwen CLI does not recognize', async () => {
    const provider = new QwenProvider();
    await provider.connect({});
    await provider.createSession({
      sessionKey: 'sess-unknown-auth',
      cwd: '/tmp/project',
      settings: {
        // e.g. a value from shared/qwen-auth.ts (display-tier), not a CLI value
        security: { auth: { selectedType: 'coding-plan' } },
      },
    });

    await provider.send('sess-unknown-auth', 'hello');
    const spawned = lastSpawn();
    // Unknown values must not be forwarded — CLI would reject the spawn.
    expect(spawned.args.includes('--auth-type')).toBe(false);
  });

  it('preserves preset settings (security + modelProviders + model.name) when effort changes on subsequent sends', async () => {
    const provider = new QwenProvider();
    await provider.connect({});
    await provider.createSession({
      sessionKey: 'sess-preset-effort',
      cwd: '/tmp/project',
      effort: 'medium',
      agentId: 'MiniMax-M2.7',
      settings: {
        security: { auth: { selectedType: 'anthropic' } },
        model: { name: 'MiniMax-M2.7' },
        modelProviders: {
          anthropic: [
            {
              id: 'MiniMax-M2.7',
              envKey: 'ANTHROPIC_API_KEY',
              baseUrl: 'https://api.minimax.io/anthropic',
            },
          ],
        },
      },
    });

    // First send — verify full preset config is written
    await provider.send('sess-preset-effort', 'hello');
    const first = lastSpawn();
    const settingsPath = first.env?.QWEN_CODE_SYSTEM_SETTINGS_PATH;
    expect(typeof settingsPath).toBe('string');
    expect(JSON.parse(await readFile(String(settingsPath), 'utf8'))).toEqual({
      security: { auth: { selectedType: 'anthropic' } },
      model: {
        name: 'MiniMax-M2.7',
        generationConfig: { reasoning: { effort: 'medium' } },
      },
      modelProviders: {
        anthropic: [
          {
            id: 'MiniMax-M2.7',
            envKey: 'ANTHROPIC_API_KEY',
            baseUrl: 'https://api.minimax.io/anthropic',
          },
        ],
      },
    });
    // --auth-type must still be forwarded on the first send
    const firstAuthIdx = first.args.indexOf('--auth-type');
    expect(firstAuthIdx).toBeGreaterThan(-1);
    expect(first.args[firstAuthIdx + 1]).toBe('anthropic');

    // Complete first send so second send is allowed
    first.child.stdout.write(`${JSON.stringify({ type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: 'Hi' }] } })}\n`);
    first.child.emit('close', 0, null);
    await flushIO();

    // Change effort — this is the bug path: ensureSettingsPath is called again
    // and must NOT overwrite the temp file with only { model: { generationConfig } }
    await provider.setSessionEffort('sess-preset-effort', 'high');
    await provider.send('sess-preset-effort', 'again');
    const second = lastSpawn();
    expect(second.env?.QWEN_CODE_SYSTEM_SETTINGS_PATH).toBe(String(settingsPath));
    // All preset fields must survive the rewrite
    expect(JSON.parse(await readFile(String(settingsPath), 'utf8'))).toEqual({
      security: { auth: { selectedType: 'anthropic' } },
      model: {
        name: 'MiniMax-M2.7',
        generationConfig: { reasoning: { effort: 'high' } },
      },
      modelProviders: {
        anthropic: [
          {
            id: 'MiniMax-M2.7',
            envKey: 'ANTHROPIC_API_KEY',
            baseUrl: 'https://api.minimax.io/anthropic',
          },
        ],
      },
    });
    // --auth-type must still be forwarded on the second send too
    const secondAuthIdx = second.args.indexOf('--auth-type');
    expect(secondAuthIdx).toBeGreaterThan(-1);
    expect(second.args[secondAuthIdx + 1]).toBe('anthropic');
  });

  it('passes session-specific preset env through to the spawned qwen process', async () => {
    const provider = new QwenProvider();
    await provider.connect({});
    await provider.createSession({
      sessionKey: 'sess-preset-env',
      cwd: '/tmp/project',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
        ANTHROPIC_API_KEY: 'test-token',
        ANTHROPIC_MODEL: 'MiniMax-M2.7',
      },
      settings: {
        security: { auth: { selectedType: 'anthropic' } },
        model: { name: 'MiniMax-M2.7' },
      },
    });

    await provider.send('sess-preset-env', 'hello');
    const spawned = lastSpawn();
    expect(spawned.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
      ANTHROPIC_API_KEY: 'test-token',
      ANTHROPIC_MODEL: 'MiniMax-M2.7',
    });
    // MiniMax preset ships with selectedType: anthropic — must be forwarded to
    // qwen CLI so it doesn't fall back to OAuth via user-level settings.
    const authTypeIndex = spawned.args.indexOf('--auth-type');
    expect(authTypeIndex).toBeGreaterThan(-1);
    expect(spawned.args[authTypeIndex + 1]).toBe('anthropic');
  });

  it('uses --session-id on first send, streams cumulative deltas, then resumes with --resume', async () => {
    const provider = new QwenProvider();
    await provider.connect({});
    await provider.createSession({
      sessionKey: 'sess-1',
      cwd: '/tmp/project',
      description: 'Be concise',
      agentId: 'qwen3-coder-plus',
    });

    const deltas: string[] = [];
    const completed: string[] = [];
    provider.onDelta((_sid, delta) => deltas.push(delta.delta));
    provider.onComplete((_sid, msg) => completed.push(String(msg.content)));

    await provider.send('sess-1', 'hello');
    const first = lastSpawn();
    // file may be 'qwen' (Linux/Mac) or node.exe (Windows where qwen is a .cmd shim)
    expect(first.file === 'qwen' || /node(\.exe)?$/i.test(first.file)).toBe(true);
    expect(first.cwd).toBe('/tmp/project');
    expect(first.args).toContain('--session-id');
    expect(first.args).toContain('sess-1');
    expect(first.args).not.toContain('--resume');
    expect(first.args).toContain('--append-system-prompt');
    expect(first.args).toContain('Be concise');
    expect(first.args).toContain('--model');
    expect(first.args).toContain('qwen3-coder-plus');

    first.child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'session_start', session_id: 'sess-1' })}\n`);
    first.child.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-1' } } })}\n`);
    first.child.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } })}\n`);
    first.child.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } })}\n`);
    first.child.stdout.write(`${JSON.stringify({ type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: 'Hello' }] } })}\n`);
    first.child.emit('close', 0, null);
    await flushIO();

    expect(deltas).toEqual(['Hel', 'Hello']);
    expect(completed).toEqual(['Hello']);

    await provider.send('sess-1', 'again');
    const second = lastSpawn();
    expect(second.args).toContain('--resume');
    expect(second.args).toContain('sess-1');
    expect(second.args).not.toContain('--session-id');
  });

  it('maps normalized payloads into qwen CLI prompt/system arguments', async () => {
    const provider = new QwenProvider();
    await provider.connect({});
    await provider.createSession({
      sessionKey: 'sess-payload',
      cwd: '/tmp/project',
      description: 'Legacy description',
    });

    const payload: ProviderContextPayload = {
      userMessage: 'ship it',
      assembledMessage: 'Context block\n\nship it',
      systemText: 'Normalized system text',
      messagePreamble: 'Context block',
      attachments: [],
      context: {
        systemText: 'Normalized system text',
        messagePreamble: 'Context block',
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
      authority: {
        namespace: { scope: 'personal', projectId: 'sess-payload' },
        authoritySource: 'none',
        freshness: 'missing',
        fallbackAllowed: true,
        retryScheduled: false,
        diagnostics: [],
      },
      supportClass: 'degraded-message-side-context-mapping',
      diagnostics: [],
    };

    await provider.send('sess-payload', payload);
    const spawnEntry = lastSpawn();
    expect(spawnEntry.args).toContain('-p');
    expect(spawnEntry.args).toContain('Context block\n\nship it');
    expect(spawnEntry.args).toContain('--append-system-prompt');
    expect(spawnEntry.args).toContain('Normalized system text');
  });

  it('rejects normalized payloads combined with legacy extraSystemPrompt', async () => {
    const provider = new QwenProvider();
    await provider.connect({});
    await provider.createSession({
      sessionKey: 'sess-payload',
      cwd: '/tmp/project',
    });

    await expect(provider.send('sess-payload', {
      userMessage: 'ship it',
      assembledMessage: 'Context block\n\nship it',
      systemText: 'Normalized system text',
      messagePreamble: 'Context block',
      attachments: [],
      context: {
        systemText: 'Normalized system text',
        messagePreamble: 'Context block',
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
      authority: {
        namespace: { scope: 'personal', projectId: 'sess-payload' },
        authoritySource: 'none',
        freshness: 'missing',
        fallbackAllowed: true,
        retryScheduled: false,
        diagnostics: [],
      },
      supportClass: 'degraded-message-side-context-mapping',
      diagnostics: [],
    }, undefined, 'legacy raw context')).rejects.toThrow(/legacy extraSystemPrompt/i);
  });

  it('falls back to a fresh session when --resume points to a missing qwen conversation id', async () => {
    const provider = new QwenProvider();
    await provider.connect({});
    await provider.createSession({
      sessionKey: 'sess-resume-fallback',
      cwd: '/tmp/project',
    });

    const completed: string[] = [];
    const resumeIds: string[] = [];
    provider.onComplete((_sid, msg) => completed.push(String(msg.content)));
    provider.onSessionInfo?.((_sid, info) => {
      if (typeof info.resumeId === 'string') resumeIds.push(info.resumeId);
    });

    await provider.send('sess-resume-fallback', 'hello');
    const first = lastSpawn();
    first.child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'session_start', session_id: 'sess-resume-fallback' })}\n`);
    first.child.stdout.write(`${JSON.stringify({ type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: 'Hello' }] } })}\n`);
    first.child.emit('close', 0, null);
    await flushIO();

    await provider.send('sess-resume-fallback', 'again');
    const second = childProcessMock.spawned[1];
    expect(second?.args).toContain('--resume');
    second?.child.stderr.write('No saved session found with ID sess-resume-fallback\n');
    second?.child.emit('close', 1, null);
    await waitForSpawnCount(3);

    const third = childProcessMock.spawned[2];
    expect(third?.args).toContain('--session-id');
    expect(third?.args).not.toContain('--resume');
    const sessionIdIndex = third?.args.indexOf('--session-id') ?? -1;
    expect(sessionIdIndex).toBeGreaterThanOrEqual(0);
    expect(third?.args[sessionIdIndex + 1]).not.toBe('sess-resume-fallback');
    expect(resumeIds).toContain(third?.args[sessionIdIndex + 1]);

    third?.child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'session_start', session_id: third?.args[sessionIdIndex + 1] })}\n`);
    third?.child.stdout.write(`${JSON.stringify({ type: 'assistant', message: { id: 'msg-2', content: [{ type: 'text', text: 'Recovered' }] } })}\n`);
    third?.child.emit('close', 0, null);
    await flushIO();

    expect(completed).toContain('Recovered');
  });

  it('accepts a normalized provider payload', async () => {
    const provider = new QwenProvider();
    await provider.connect({});
    await provider.createSession({
      sessionKey: 'sess-payload',
      cwd: '/tmp/project',
    });

    await provider.send('sess-payload', {
      userMessage: 'hello',
      assembledMessage: 'Shared history\n\nhello',
      systemText: 'Enterprise standard',
      messagePreamble: 'Shared history',
      attachments: undefined,
      context: {
        systemText: 'Enterprise standard',
        messagePreamble: 'Shared history',
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
      authority: {
        namespace: { scope: 'project_shared', projectId: 'repo' },
        authoritySource: 'processed_remote',
        freshness: 'fresh',
        fallbackAllowed: false,
        retryScheduled: false,
        diagnostics: [],
      },
      supportClass: 'full-normalized-context-injection',
      diagnostics: [],
    });

    const run = lastSpawn();
    expect(run.args).toContain('-p');
    expect(run.args).toContain('Shared history\n\nhello');
    expect(run.args).toContain('--append-system-prompt');
    expect(run.args).toContain('Enterprise standard');
  });

  it('normalizes Windows cwd before spawning qwen', async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });

    try {
      const provider = new QwenProvider();
      await provider.connect({});
      await provider.createSession({
        sessionKey: 'sess-win',
        cwd: 'C:\\Users\\admin\\project',
      });

      await provider.send('sess-win', 'hello');
      const run = lastSpawn();
      expect(run.cwd).toBe('C:/Users/admin/project');
      expect(run.cwd).not.toContain('\\');
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }
  });

  it('keeps the streaming message id for final completion when qwen emits a different assistant id', async () => {
    const provider = new QwenProvider();
    await provider.connect({});
    await provider.createSession({ sessionKey: 'sess-2', cwd: '/tmp/project' });

    const completeIds: string[] = [];
    const metadata: Array<Record<string, unknown> | undefined> = [];
    provider.onComplete((_sid, msg) => { completeIds.push(msg.id); metadata.push(msg.metadata); });

    await provider.send('sess-2', 'hello');
    const run = lastSpawn();
    run.child.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'stream-msg-1' } } })}\n`);
    run.child.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } } })}\n`);
    run.child.stdout.write(`${JSON.stringify({ type: 'assistant', message: { id: 'assistant-msg-2', model: 'qwen3.5-plus', usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2 }, content: [{ type: 'text', text: 'Hello' }] } })}\n`);
    run.child.emit('close', 0, null);
    await flushIO();

    expect(completeIds).toEqual(['stream-msg-1']);
    expect(metadata[0]).toEqual({
      model: 'qwen3.5-plus',
      usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2 },
    });
  });

  it('prefers assistant per-turn usage over cumulative result usage for ctx display', async () => {
    const provider = new QwenProvider();
    await provider.connect({});
    await provider.createSession({ sessionKey: 'sess-usage', cwd: '/tmp/project', agentId: 'coder-model' });

    const metadata: Array<Record<string, unknown> | undefined> = [];
    provider.onComplete((_sid, msg) => { metadata.push(msg.metadata); });

    await provider.send('sess-usage', 'hello');
    const run = lastSpawn();
    run.child.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'stream-msg-usage' } } })}\n`);
    run.child.stdout.write(`${JSON.stringify({
      type: 'assistant',
      message: {
        id: 'assistant-msg-usage',
        model: 'coder-model',
        usage: { input_tokens: 321, output_tokens: 12, cache_read_input_tokens: 45 },
        content: [{ type: 'text', text: 'Hello' }],
      },
    })}\n`);
    run.child.stdout.write(`${JSON.stringify({
      type: 'result',
      is_error: false,
      result: 'Hello',
      usage: { input_tokens: 11_000_000, output_tokens: 12, cache_read_input_tokens: 500_000 },
    })}\n`);
    run.child.emit('close', 0, null);
    await flushIO();

    expect(metadata[0]).toEqual({
      model: 'coder-model',
      usage: { input_tokens: 321, output_tokens: 12, cache_read_input_tokens: 45 },
    });
  });


  it('queued messages batch-drain after the active turn completes', async () => {
    const provider = new QwenProvider();
    await provider.connect({});
    const runtime = new TransportSessionRuntime(provider, 'sess-queue');
    await runtime.initialize({ sessionKey: 'sess-queue', cwd: '/tmp/project' });

    // First send dispatches immediately
    runtime.send('first');
    await waitForSpawnCount(1);
    const first = lastSpawn();
    first.child.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-queue-1' } } })}\n`);
    first.child.stdout.write(`${JSON.stringify({ type: 'assistant', message: { id: 'assistant-queue-1', content: [{ type: 'text', text: 'Still running' }] } })}\n`);
    await flushIO();

    // Second send queues (runtime is busy)
    const result = runtime.send('second');
    expect(result).toBe('queued');
    expect(runtime.pendingCount).toBe(1);
    await flushIO();
    expect(childProcessMock.spawn).toHaveBeenCalledTimes(1);

    // Complete first turn → pending drains as merged turn
    first.child.emit('close', 0, null);
    await waitForSpawnCount(2);

    expect(childProcessMock.spawn).toHaveBeenCalledTimes(2);
    expect(runtime.pendingCount).toBe(0);
  });

  it('does not drain queued messages until the qwen process closes', async () => {
    const provider = new QwenProvider();
    await provider.connect({});
    const runtime = new TransportSessionRuntime(provider, 'sess-queue-close-gate');
    await runtime.initialize({ sessionKey: 'sess-queue-close-gate', cwd: '/tmp/project' });

    const errors: string[] = [];
    provider.onError((_sid, err) => errors.push(err.message));

    runtime.send('first');
    await waitForSpawnCount(1);
    const first = lastSpawn();
    first.child.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-queue-close-1' } } })}\n`);
    first.child.stdout.write(`${JSON.stringify({ type: 'result', is_error: false, result: 'done' })}\n`);
    await flushIO();

    expect(runtime.send('second')).toBe('queued');
    expect(runtime.pendingCount).toBe(1);
    await flushIO();

    // Result arrived, but the underlying CLI process is still alive.
    // The important invariant is that this does not surface an "already busy"
    // provider error while waiting for the underlying close.
    expect(errors).toEqual([]);

    first.child.emit('close', 0, null);
    await waitForSpawnCount(2);

    expect(childProcessMock.spawn).toHaveBeenCalledTimes(2);
    expect(runtime.pendingCount).toBe(0);
    expect(errors).toEqual([]);
  });

  it('emits provider error on result is_error payload', async () => {
    const provider = new QwenProvider();
    await provider.connect({});
    await provider.createSession({ sessionKey: 'sess-err', cwd: '/tmp/project' });

    const errors: string[] = [];
    provider.onError((_sid, err) => errors.push(err.message));

    await provider.send('sess-err', 'fail');
    const run = lastSpawn();
    run.child.stdout.write(`${JSON.stringify({ type: 'result', is_error: true, error: { message: 'bad request' } })}\n`);
    await flushIO();

    expect(errors).toEqual(['bad request']);
  });

  it('cancel() terminates the child and emits a cancelled error', async () => {
    const provider = new QwenProvider();
    await provider.connect({});
    await provider.createSession({ sessionKey: 'sess-cancel', cwd: '/tmp/project' });

    const errors: Array<{ code: string; message: string }> = [];
    provider.onError((_sid, err) => errors.push({ code: err.code, message: err.message }));

    await provider.send('sess-cancel', 'cancel me');
    const run = lastSpawn();
    await provider.cancel?.('sess-cancel');
    await flushIO();

    expect(run.child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(errors).toEqual([{ code: 'CANCELLED', message: 'Cancelled' }]);
  });

  it('emits tool.call and tool.result events for qwen tool blocks', async () => {
    const provider = new QwenProvider();
    await provider.connect({});
    await provider.createSession({ sessionKey: 'sess-tool', cwd: '/tmp/project' });

    const tools: ToolCallEvent[] = [];
    provider.onToolCall?.((_sid, tool) => tools.push(tool));

    await provider.send('sess-tool', 'use a tool');
    const run = lastSpawn();
    run.child.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-1', name: 'list_directory' } } })}\n`);
    run.child.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{\"path\":\"/tmp/project\"}' } } })}\n`);
    run.child.stdout.write(`${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok', is_error: false }] } })}\n`);
    run.child.emit('close', 0, null);
    await flushIO();

    expect(tools).toEqual([
      {
        id: 'tool-1',
        name: 'list_directory',
        status: 'running',
        input: { path: '/tmp/project' },
        detail: {
          kind: 'tool_use',
          summary: 'list_directory',
          input: { path: '/tmp/project' },
          raw: { id: 'tool-1', name: 'list_directory', input: { path: '/tmp/project' }, partialJson: '{"path":"/tmp/project"}' },
        },
      },
      {
        id: 'tool-1',
        name: 'list_directory',
        status: 'complete',
        output: 'ok',
        detail: {
          kind: 'tool_result',
          summary: 'list_directory',
          output: 'ok',
          raw: { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok', is_error: false },
        },
      },
    ]);
  });

  it('emits thinking status from qwen thinking blocks and clears it on text output', async () => {
    const provider = new QwenProvider();
    await provider.connect({});
    await provider.createSession({ sessionKey: 'sess-thinking', cwd: '/tmp/project' });

    const statuses: Array<{ status: string | null; label?: string | null }> = [];
    provider.onStatus?.((_sid, status) => statuses.push(status));

    await provider.send('sess-thinking', 'think');
    const run = lastSpawn();
    run.child.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-thinking' } } })}\n`);
    run.child.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } })}\n`);
    run.child.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Analyzing...' } } })}\n`);
    run.child.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Done' } } })}\n`);
    run.child.emit('close', 0, null);
    await flushIO();

    expect(statuses).toEqual([
      { status: null, label: null },
      { status: 'thinking', label: 'Thinking...' },
      { status: null, label: null },
    ]);
  });
});
