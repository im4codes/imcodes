import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AgySdkProvider,
  buildAgyArgs,
  encodeAgyUserLine,
  parseAgyModelList,
} from '../../src/agent/providers/agy-sdk.js';
import { AGY_CLI_FLAG, AGY_SDK_PROVIDER_ID } from '../../shared/agy-agent.js';
import { PROVIDER_ERROR_CODES } from '../../src/agent/transport-provider.js';
import type { AgentMessage, MessageDelta, ToolCallEvent } from '../../shared/agent-message.js';
import type { ProviderError, SessionInfoUpdate } from '../../src/agent/transport-provider.js';

/**
 * A fake `agy` that speaks the verified stream-json wire format. Behaviour is
 * driven by keywords in the user message so one script covers every path.
 */
const FAKE_AGY = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_AGY_ARGS_FILE) fs.appendFileSync(process.env.FAKE_AGY_ARGS_FILE, JSON.stringify(args) + '\\n');
if (args[0] === 'models') {
  process.stdout.write('Fetching available models...\\ngemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\nclaude-sonnet-5-5-low\\tClaude Sonnet 5.5 (Low)\\n');
  process.exit(0);
}
if (args[0] === '--help') { process.stdout.write('Usage of agy:\\n'); process.exit(0); }
const resumeIdx = args.indexOf('--conversation');
const convId = resumeIdx >= 0 ? args[resumeIdx + 1] : 'conv-' + process.pid;
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
emit({ event: 'init', conversation_id: convId, init: { cwd: process.cwd(), tools: [], permission_mode: 'always-proceed' } });
let step = 0;
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const text = msg.message.content;
    emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: step++, state: 'DONE', step_type: 'user_input' } });
    if (text.includes('HANG')) return;
    if (text.includes('FAIL')) {
      emit({ event: 'result', result: { conversation_id: convId, status: 'ERROR', response: '', error: 'boom unauthorized', num_turns: 0, usage: {} } });
      continue;
    }
    if (text.includes('MULTI_STEP')) {
      const idx1 = step++;
      emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: idx1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Before' } });
      emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: idx1, state: 'DONE', step_type: 'agent_response', text_delta: '\\n' } });
      const idxTool = step++;
      emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: idxTool, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo mid' } } } });
      emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: idxTool, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo mid' }, output: 'mid\\r\\n' } } });
      const idx2 = step++;
      emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: idx2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'After' } });
      emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: idx2, state: 'DONE', step_type: 'agent_response', text_delta: '\\n' } });
      emit({ event: 'result', result: { conversation_id: convId, status: 'SUCCESS', response: 'Before\\nAfter\\n', num_turns: 1, usage: {} } });
      continue;
    }
    if (text.includes('TOOL')) {
      const idx = step++;
      emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: idx, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' } } } });
      emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: idx, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' }, output: 'hi\\r\\n' } } });
    }
    const idx = step++;
    emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: idx, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Hel' } });
    emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: idx, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'lo' } });
    emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: idx, state: 'DONE', step_type: 'agent_response', text_delta: '\\n', usage: { input_tokens: 5, output_tokens: 2 } } });
    emit({ event: 'result', result: { conversation_id: convId, status: 'SUCCESS', response: 'Hello\\n', num_turns: 1, usage: { input_tokens: 5, output_tokens: 2, cache_read_tokens: 7 } } });
  }
});
`;

describe('agy-sdk helpers', () => {
  it('builds stream-json argv that skips permissions and keeps --print= last', () => {
    const args = buildAgyArgs({ conversationId: 'c1', model: 'm1' });
    expect(args).toContain(AGY_CLI_FLAG.SKIP_PERMISSIONS);
    expect(args.slice(args.indexOf(AGY_CLI_FLAG.CONVERSATION), args.indexOf(AGY_CLI_FLAG.CONVERSATION) + 2)).toEqual(['--conversation', 'c1']);
    expect(args.slice(args.indexOf(AGY_CLI_FLAG.MODEL), args.indexOf(AGY_CLI_FLAG.MODEL) + 2)).toEqual(['--model', 'm1']);
    expect(args[args.length - 1]).toBe(AGY_CLI_FLAG.PRINT_STDIN);
    expect(buildAgyArgs({})).not.toContain(AGY_CLI_FLAG.CONVERSATION);
  });

  it('parses `agy models` output and ignores the banner', () => {
    expect(parseAgyModelList('Fetching available models...\nid-a\tName A\nid-b\tName B (Low)\n')).toEqual([
      { id: 'id-a', name: 'Name A' },
      { id: 'id-b', name: 'Name B (Low)' },
    ]);
    expect(parseAgyModelList('Fetching available models...\n')).toEqual([]);
  });

  it('parses real `agy models` output with multiple spaces and spinner characters', () => {
    const raw = [
      '⠋ Fetching available models...',
      '⠙ Fetching available models...',
      'gemini-3.8-flash-high     Gemini 3.8 Flash (High)',
      'gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)',
      'claude-opus-5-5-low\tClaude Opus 5.5 (Low)',
    ].join('\n');
    expect(parseAgyModelList(raw)).toEqual([
      { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
      { id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' },
      { id: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 (Low)' },
    ]);
  });

  it('encodes one NDJSON user line', () => {
    const line = encodeAgyUserLine('hi\nthere');
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1).includes('\n')).toBe(false);
    expect(JSON.parse(line)).toEqual({ event: 'user', message: { content: 'hi\nthere' } });
  });
});

describe('AgySdkProvider (fake agy process)', () => {
  let dir: string;
  let argsFile: string;
  let provider: AgySdkProvider;
  const completes: Array<[string, AgentMessage]> = [];
  const deltas: Array<[string, MessageDelta]> = [];
  const errors: Array<[string, ProviderError]> = [];
  const tools: Array<[string, ToolCallEvent]> = [];
  const infos: Array<[string, SessionInfoUpdate]> = [];

  function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (predicate()) return resolve();
        if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting for provider event'));
        setTimeout(tick, 15);
      };
      tick();
    });
  }

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'imcodes-agy-test-'));
    const bin = path.join(dir, 'agy');
    writeFileSync(bin, FAKE_AGY);
    chmodSync(bin, 0o755);
    argsFile = path.join(dir, 'args.log');
    writeFileSync(argsFile, '');
    completes.length = 0; deltas.length = 0; errors.length = 0; tools.length = 0; infos.length = 0;
    provider = new AgySdkProvider();
    provider.onComplete((s, m) => completes.push([s, m]));
    provider.onDelta((s, d) => deltas.push([s, d]));
    provider.onError((s, e) => errors.push([s, e]));
    provider.onToolCall((s, t) => tools.push([s, t]));
    provider.onSessionInfo((s, i) => infos.push([s, i]));
    await provider.connect({ binaryPath: bin, env: { FAKE_AGY_ARGS_FILE: argsFile } });
  });

  afterEach(async () => {
    await provider.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  const launches = () => readFileSync(argsFile, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as string[]).filter((a) => a[0] !== '--help' && a[0] !== 'models');

  it('declares the provider identity and capabilities', () => {
    expect(provider.id).toBe(AGY_SDK_PROVIDER_ID);
    expect(provider.capabilities.streaming).toBe(true);
    expect(provider.capabilities.sessionRestore).toBe(true);
    expect(provider.capabilities.approval).toBe(false);
  });

  it('reports memory MCP status ready or degraded', () => {
    const status = provider.getMemoryMcpStatus();
    expect(status.providerId).toBe(AGY_SDK_PROVIDER_ID);
    expect(status.connected).toBe(true);
    expect(['ready', 'degraded']).toContain(status.status);
  });

  it('streams deltas, completes the turn and reports the conversation id for resume', async () => {
    const sid = await provider.createSession({ sessionKey: 's1', cwd: dir });
    await provider.send(sid, 'say hello');
    await waitFor(() => completes.length === 1);
    expect(deltas.map(([, d]) => d.delta)).toEqual(['Hel', 'Hello']);
    expect(new Set(deltas.map(([, d]) => d.messageId)).size).toBe(1);
    expect(completes[0][1].content).toBe('Hello');
    expect(completes[0][1].id).toBe(deltas[0][1].messageId);
    expect(infos.some(([, i]) => typeof i.resumeId === 'string' && i.resumeId.startsWith('conv-'))).toBe(true);
    expect(launches()[0]).toContain('--dangerously-skip-permissions');
    expect(launches()[0]).not.toContain('--conversation');
  });

  it('appends messages to the same process and completes them in order', async () => {
    const sid = await provider.createSession({ sessionKey: 's2', cwd: dir });
    await provider.send(sid, 'first');
    await provider.send(sid, 'second');
    await waitFor(() => completes.length === 2);
    expect(launches()).toHaveLength(1);
    expect(completes[0][1].id).not.toBe(completes[1][1].id);
  });

  it('emits tool call lifecycle events with parameters and output', async () => {
    const sid = await provider.createSession({ sessionKey: 's3', cwd: dir });
    await provider.send(sid, 'please TOOL');
    await waitFor(() => completes.length === 1);
    expect(tools.map(([, t]) => t.status)).toEqual(['running', 'complete']);
    expect(tools[0][1].name).toBe('run_command');
    expect(tools[0][1].input).toEqual({ CommandLine: 'echo hi' });
    expect(tools[1][1].output).toBe('hi\r\n');
    expect(tools[0][1].id).toBe(tools[1][1].id);
  });

  it('handles multi-step turns with tool calls separating agent responses without duplicating earlier steps', async () => {
    const sid = await provider.createSession({ sessionKey: 's3-multi', cwd: dir });
    await provider.send(sid, 'please MULTI_STEP');
    await waitFor(() => completes.length === 1);
    expect(deltas.map(([, d]) => d.delta)).toEqual(['Before', 'After']);
    expect(deltas[0][1].messageId).not.toBe(deltas[1][1].messageId);
    expect(tools.map(([, t]) => t.status)).toEqual(['running', 'complete']);
    expect(completes[0][1].content).toBe('After');
    expect(completes[0][1].id).toBe(deltas[1][1].messageId);
  });

  it('maps a failed result to a provider error without completing', async () => {
    const sid = await provider.createSession({ sessionKey: 's4', cwd: dir });
    await provider.send(sid, 'FAIL');
    await waitFor(() => errors.length === 1);
    expect(errors[0][1].code).toBe(PROVIDER_ERROR_CODES.AUTH_FAILED);
    expect(errors[0][1].recoverable).toBe(false);
    expect(completes).toHaveLength(0);
  });

  it('cancel kills the process and the next send resumes the same conversation', async () => {
    const sid = await provider.createSession({ sessionKey: 's5', cwd: dir });
    await provider.send(sid, 'HANG');
    await waitFor(() => infos.length > 0);
    const convId = infos[0][1].resumeId!;
    await provider.cancel(sid);
    expect(errors.some(([, e]) => e.code === PROVIDER_ERROR_CODES.CANCELLED)).toBe(true);
    await provider.send(sid, 'again');
    await waitFor(() => completes.length === 1);
    const resumed = launches()[1];
    expect(resumed.slice(resumed.indexOf('--conversation'), resumed.indexOf('--conversation') + 2)).toEqual(['--conversation', convId]);
    expect(completes[0][1].content).toBe('Hello');
  });

  it('resumes a persisted conversation id passed through createSession and applies the model', async () => {
    const sid = await provider.createSession({ sessionKey: 's6', cwd: dir, resumeId: 'persisted-1', agentId: 'claude-sonnet-5-5-low' });
    await provider.send(sid, 'hi');
    await waitFor(() => completes.length === 1);
    const args = launches()[0];
    expect(args.slice(args.indexOf('--conversation'), args.indexOf('--conversation') + 2)).toEqual(['--conversation', 'persisted-1']);
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'claude-sonnet-5-5-low']);
  });

  it('relaunches with the new model after setSessionAgentId on an idle session', async () => {
    const sid = await provider.createSession({ sessionKey: 's7', cwd: dir, agentId: 'gemini-3.8-flash-high' });
    await provider.send(sid, 'one');
    await waitFor(() => completes.length === 1);
    provider.setSessionAgentId(sid, 'claude-sonnet-5-5-low');
    await provider.send(sid, 'two');
    await waitFor(() => completes.length === 2);
    const second = launches()[1];
    expect(second.slice(second.indexOf('--model'), second.indexOf('--model') + 2)).toEqual(['--model', 'claude-sonnet-5-5-low']);
    expect(second).toContain('--conversation');
  });

  it('lists models from `agy models` with caching', async () => {
    const first = await provider.listModels();
    expect(first.isAuthenticated).toBe(true);
    expect(first.models.map((m) => m.id)).toEqual(['gemini-3.8-flash-high', 'claude-sonnet-5-5-low']);
    await provider.listModels();
    const modelProbes = readFileSync(argsFile, 'utf8').trim().split('\n').filter((l) => l.includes('"models"'));
    expect(modelProbes).toHaveLength(1);
    await provider.listModels(true);
    expect(readFileSync(argsFile, 'utf8').trim().split('\n').filter((l) => l.includes('"models"'))).toHaveLength(2);
  });

  it('reports a config error when the binary is missing', async () => {
    const broken = new AgySdkProvider();
    await expect(broken.connect({ binaryPath: path.join(dir, 'does-not-exist') }))
      .rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.CONFIG_ERROR });
    expect(await broken.listModels()).toMatchObject({ models: [], isAuthenticated: false });
  });
});
