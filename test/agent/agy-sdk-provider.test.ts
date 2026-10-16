import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withMemoryMcpSessionEnv } from '../../src/agent/providers/getDefaultMcpServers.js';
import { MEMORY_MCP_ENV_KEYS as E } from '../../shared/memory-mcp-env.js';
import { IMCODES_SESSION_ENV } from '../../shared/imcodes-send.js';
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
import {
  SDK_SUBAGENT_DETAIL_KIND,
  SDK_SUBAGENT_PROVIDERS,
  SDK_SUBAGENT_PROVIDER_KINDS,
  SDK_SUBAGENT_STATUS,
} from '../../shared/sdk-subagent-status.js';
import { AgyHistoryReader } from '../../src/agent/agy-native-history.js';
import { PROVIDER_ERROR_CODES } from '../../src/agent/transport-provider.js';
import type { AgentMessage, MessageDelta, ToolCallEvent } from '../../shared/agent-message.js';
import type { ProviderError, ProviderUsageUpdate, SessionInfoUpdate } from '../../src/agent/transport-provider.js';

/**
 * A fake `agy` that speaks the verified stream-json wire format. Behaviour is
 * driven by keywords in the user message so one script covers every path.
 */
const FAKE_AGY = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_AGY_ARGS_FILE) fs.appendFileSync(process.env.FAKE_AGY_ARGS_FILE, JSON.stringify(args) + '\\n');
if (args[0] === 'models') {
  process.stdout.write('Fetching available models...\\nclaude-sonnet-5-5-low\\tClaude Sonnet 5.5 (Low)\\ngemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\n');
  process.exit(0);
}
if (args[0] === '--help') { process.stdout.write('Usage of agy:\\n'); process.exit(0); }
if (process.env.FAKE_AGY_IDENTITY_FILE) fs.appendFileSync(process.env.FAKE_AGY_IDENTITY_FILE, JSON.stringify(Object.fromEntries(${JSON.stringify([IMCODES_SESSION_ENV,E.SESSION_NAME,E.SESSION_INSTANCE_ID,E.RUNTIME_EPOCH,E.PROVIDER_ID])}.map(k => [k, process.env[k]]))) + '\\n');
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
    if (text.includes('CRASH_NOW')) process.exit(1);
    if (text.includes('NATIVE_LOST')) {
      const fixture = require(process.env.FAKE_AGY_NATIVE_FIXTURE);
      fixture.persist(process.env.HOME, text, { currentError: text.includes('NATIVE_LOST_REAL_ERROR'), answer: text });
      emit({ event:'result', result:{ conversation_id:convId, status:'ERROR', response:'', error:fixture.ERROR } });
      continue;
    }
    if (text.includes('QUOTA_OLD_RESPONSE')) {
      emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: step++, state: 'DONE', step_type: 'agent_response', text_delta: 'Hello\\n' } });
    }
    if (!text.includes('QUOTA_NO_BOUNDARY')) {
      emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: step++, state: 'DONE', step_type: 'user_input' } });
    }
    if (text.includes('QUOTA_')) {
      const quota = 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 50m15s.';
      const hasResponse = !text.includes('QUOTA_EMPTY') && !text.includes('QUOTA_OLD_RESPONSE');
      if (text.includes('QUOTA_MULTISTEP')) {
        emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: step++, state: 'DONE', step_type: 'agent_response', text_delta: 'Before\\n' } });
      }
      if (text.includes('QUOTA_COMPLETED_TOOL') || text.includes('QUOTA_MULTISTEP')) {
        const toolIdx = step++;
        emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: toolIdx, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: {} } } });
        emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: toolIdx, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: {}, output: 'ok' } } });
      }

      const idx = step++;
      if (hasResponse) {
        const stepIndex = text.includes('QUOTA_NO_INDEX') ? undefined : idx;
        emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: stepIndex, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Hello' } });
        if (!text.includes('QUOTA_PARTIAL')) {
          emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: stepIndex, state: 'DONE', step_type: 'agent_response', text_delta: '\\n', ...(text.includes('QUOTA_DETAILS') ? { error_details: { message: quota } } : {}) } });
        }
      }
      if (text.includes('QUOTA_TOOL')) emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: step++, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: {} } } });
      if (text.includes('QUOTA_CURRENT_ERROR')) emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: text.includes('NO_INDEX_ERROR') ? undefined : step++, state: 'DONE', step_type: 'system_error', text_delta: quota } });
      if (text.includes('QUOTA_ACTIVE_AFTER_DONE')) emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: idx, state: 'ACTIVE', step_type: 'agent_response', text_delta: ' more' } });
      emit({ event: 'result', result: { conversation_id: convId, status: 'ERROR', response: text.includes('QUOTA_MISMATCH') ? 'Other response' : text.includes('QUOTA_MULTISTEP') ? 'Before\\nHello\\n' : hasResponse ? 'Hello\\n' : '', error: text.includes('QUOTA_NEW_FAILURE') ? 'boom unauthorized' : quota, num_turns: 1, usage: {} } });
      if (text.includes('QUOTA_EMPTY_EXIT')) process.exit(0);
      continue;
    }
    if (text.includes('HANG')) return;
    if (text.includes('FAIL')) {
      emit({ event: 'result', result: { conversation_id: convId, status: 'ERROR', response: '', error: 'boom unauthorized', num_turns: 0, usage: {} } });
      continue;
    }
    if (text.includes('MULTI_STEP')) {
      const idx1 = step++;
      emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: idx1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Before' } });
      emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: idx1, state: 'DONE', step_type: 'agent_response', text_delta: '\\n', usage: { input_tokens: 100, output_tokens: 10 } } });
      const idxTool = step++;
      emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: idxTool, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo mid' } } } });
      emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: idxTool, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo mid' }, output: 'mid\\r\\n' } } });
      const idx2 = step++;
      emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: idx2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'After' } });
      emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: idx2, state: 'DONE', step_type: 'agent_response', text_delta: '\\n', usage: { input_tokens: 120, output_tokens: 15 } } });
      emit({ event: 'result', result: { conversation_id: convId, status: 'SUCCESS', response: 'Before\\nAfter\\n', num_turns: 1, usage: { input_tokens: 220, output_tokens: 25 } } });
      continue;
    }
    if (text.includes('TOOL')) {
      const idx = step++;
      emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: idx, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' } } } });
      emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: idx, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' }, output: 'hi\\r\\n' } } });
    }
    if (text.includes('SUBAGENT')) {
      const idx = step++;
      emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: idx, state: 'ACTIVE', step_type: 'tool', tool_name: 'invoke_subagent', tool_info: { name: 'invoke_subagent', parameters: { Subagents: [{ TypeName: 'research', Role: 'Researcher', Prompt: 'find info' }] } } } });
      emit({ event: 'step_update', step_update: { conversation_id: convId, step_index: idx, state: 'DONE', step_type: 'tool', tool_name: 'invoke_subagent', tool_info: { name: 'invoke_subagent', parameters: { Subagents: [{ TypeName: 'research', Role: 'Researcher', Prompt: 'find info' }] }, output: 'subagent task-1 launched' } } });
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

  it('parses models when progress spinner overwrites the first line via carriage return', () => {
    const raw = '⠋ Fetching available models...\r⠙ Fetching available models...\r⠦ Fetching available models...\rgemini-4-argon-medium     Gemini 4 Argon (Medium)\ngemini-4-argon-high       Gemini 4 Argon (High)\n';
    expect(parseAgyModelList(raw)).toEqual([
      { id: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
      { id: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
    ]);
  });

  it('defaults fresh and resumed launch argv to Flash High without overwriting explicit models', () => {
    for (const opts of [{}, { model: '' }, { conversationId: 'persisted-1' }]) {
      const args = buildAgyArgs(opts);
      expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'gemini-3.8-flash-high']);
      expect(args.at(-1)).toBe(AGY_CLI_FLAG.PRINT_STDIN);
    }
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
  const usages: Array<[string, ProviderUsageUpdate]> = [];

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
    completes.length = 0; deltas.length = 0; errors.length = 0; tools.length = 0; infos.length = 0; usages.length = 0;
    provider = new AgySdkProvider();
    provider.onComplete((s, m) => completes.push([s, m]));
    provider.onDelta((s, d) => deltas.push([s, d]));
    provider.onError((s, e) => errors.push([s, e]));
    provider.onToolCall((s, t) => tools.push([s, t]));
    provider.onSessionInfo((s, i) => infos.push([s, i]));
    provider.onUsage?.((s, u) => usages.push([s, u]));
    await provider.connect({ binaryPath: bin, env: { FAKE_AGY_ARGS_FILE: argsFile } });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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

  it('passes isolated runtime identity to actual Antigravity child processes for new and resumed sessions', async () => {
    const output = path.join(dir, 'identity.jsonl');
    for (const id of ['fresh', 'resume']) {
      const sid = await provider.createSession(withMemoryMcpSessionEnv({
        sessionKey: id, sessionName: `deck_sub_agy_${id}`, sessionInstanceId: `instance-${id}`, runtimeEpoch: `epoch-${id}`,
        providerId: provider.id, cwd: dir, resumeId: id === 'resume' ? 'persisted-identity-test' : undefined,
        env: { FAKE_AGY_IDENTITY_FILE: output },
      }));
      await provider.send(sid, 'hello');
    }
    await waitFor(() => completes.length === 2);
    const actual = readFileSync(output, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(actual).toHaveLength(2);
    for (const [i, id] of ['fresh', 'resume'].entries()) expect(actual[i]).toEqual({
      [IMCODES_SESSION_ENV]: `deck_sub_agy_${id}`, [E.SESSION_NAME]: `deck_sub_agy_${id}`,
      [E.SESSION_INSTANCE_ID]: `instance-${id}`, [E.RUNTIME_EPOCH]: `epoch-${id}`, [E.PROVIDER_ID]: provider.id,
    });
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
    const args = launches()[0];
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'gemini-3.8-flash-high']);
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

  it('completes repeated successful turns despite AG historical quota result errors, without restarting or replaying', async () => {
    const sid = await provider.createSession({ sessionKey: 'quota-history', cwd: dir, resumeId: 'existing-conversation' });
    await provider.send(sid, 'QUOTA_STALE');
    await waitFor(() => completes.length + errors.length === 1);
    expect(errors).toHaveLength(0);
    expect(completes[0][1].content).toBe('Hello');
    await provider.send(sid, 'QUOTA_STALE');
    await waitFor(() => completes.length + errors.length === 2);
    expect(errors).toHaveLength(0);
    expect(completes).toHaveLength(2);
    expect(launches()).toHaveLength(1);
    expect(launches()[0]).toContain('existing-conversation');
    expect(provider.getSessionDiagnostics(sid)).toMatchObject({ inflightTurns: 0 });
  });

  it('recovers DB-only answers on repeated turns and a fresh CLI process, without replay or deleting history', async () => {
    await provider.disconnect();
    await provider.connect({binaryPath:path.join(dir,'agy'),env:{HOME:dir,FAKE_AGY_ARGS_FILE:argsFile,
      FAKE_AGY_NATIVE_FIXTURE:path.resolve('test/fixtures/agy-native-history/fixture.cjs')}});
    const key = 'native-lost';
    const conversation = '11111111-1111-4111-8111-111111111111';
    let sid = await provider.createSession({sessionKey:key,cwd:dir,resumeId:conversation});
    await provider.send(sid,'NATIVE_LOST first');
    await provider.send(sid,'NATIVE_LOST second');
    await waitFor(() => completes.length+errors.length===2);
    expect(errors).toHaveLength(0);
    expect(completes.map(([,m])=>m.content)).toEqual(['NATIVE_LOST first','NATIVE_LOST second']);
    expect(launches()).toHaveLength(1);
    await provider.endSession(sid);
    sid = await provider.createSession({sessionKey:key,cwd:dir,resumeId:conversation});
    await provider.send(sid,'NATIVE_LOST third');
    await waitFor(() => completes.length+errors.length===3);
    expect(errors).toHaveLength(0);
    expect(completes[2][1].content).toBe('NATIVE_LOST third');
    expect(launches()).toHaveLength(2); // only the EXPLICIT session end started a new CLI
    expect(provider.getSessionDiagnostics(sid)).toMatchObject({inflightTurns:0});
  });

  it('keeps genuine current native quota failures even when a completed answer precedes them', async () => {
    await provider.disconnect();
    await provider.connect({binaryPath:path.join(dir,'agy'),env:{HOME:dir,FAKE_AGY_ARGS_FILE:argsFile,
      FAKE_AGY_NATIVE_FIXTURE:path.resolve('test/fixtures/agy-native-history/fixture.cjs')}});
    const sid = await provider.createSession({sessionKey:'native-error',cwd:dir,resumeId:'11111111-1111-4111-8111-111111111111'});
    await provider.send(sid,'NATIVE_LOST_REAL_ERROR');
    await waitFor(() => completes.length+errors.length===1);
    expect(completes).toHaveLength(0);
    expect(errors[0][1].code).toBe(PROVIDER_ERROR_CODES.RATE_LIMITED);
  });

  it('clears failed-process input bindings before the next user turn resumes the conversation', async () => {
    await provider.disconnect();
    await provider.connect({binaryPath:path.join(dir,'agy'),env:{HOME:dir,FAKE_AGY_ARGS_FILE:argsFile,
      FAKE_AGY_NATIVE_FIXTURE:path.resolve('test/fixtures/agy-native-history/fixture.cjs')}});
    const sid=await provider.createSession({sessionKey:'unexpected-exit',cwd:dir,resumeId:'11111111-1111-4111-8111-111111111111'});
    await provider.send(sid,'CRASH_NOW');
    await waitFor(()=>errors.length===1);
    expect(errors[0][1].code).toBe(PROVIDER_ERROR_CODES.CONNECTION_LOST);
    await provider.send(sid,'NATIVE_LOST after unexpected exit');
    await waitFor(()=>completes.length+errors.length===2);
    expect(errors).toHaveLength(1);
    expect(completes[0][1].content).toBe('NATIVE_LOST after unexpected exit');
    expect(provider.getSessionDiagnostics(sid)).toMatchObject({inflightTurns:0});
  });

  it('serializes queued frames across a slow recovery without replaying or mixing answers', async () => {
    let finish!: (value: {userStepIndex:number;responseStepIndex:number;text:string}) => void;
    const read = vi.spyOn(AgyHistoryReader.prototype,'read').mockImplementation(() => new Promise(resolve => { finish=resolve; }));
    const sid=await provider.createSession({sessionKey:'slow-read',cwd:dir,resumeId:'11111111-1111-4111-8111-111111111111'});
    await provider.send(sid,'QUOTA_EMPTY');
    await waitFor(() => read.mock.calls.length===1);
    await provider.send(sid,'next ordinary input');
    expect(completes).toHaveLength(0);
    finish({userStepIndex:0,responseStepIndex:1,text:'Recovered first'});
    await waitFor(() => completes.length===2);
    expect(errors).toHaveLength(0);
    expect(completes.map(([,m])=>m.content)).toEqual(['Recovered first','Hello']);
    expect(launches()).toHaveLength(1);
  });

  it.each(['stop','end','fresh','disconnect'])('does not publish late recovery after %s', async action => {
    let finish!: (value: {userStepIndex:number;responseStepIndex:number;text:string}) => void;
    const read = vi.spyOn(AgyHistoryReader.prototype,'read').mockImplementation(() => new Promise(resolve => { finish=resolve; }));
    const key='late-read';
    const sid=await provider.createSession({sessionKey:key,cwd:dir,resumeId:'11111111-1111-4111-8111-111111111111'});
    await provider.send(sid,'QUOTA_EMPTY');
    await waitFor(() => read.mock.calls.length===1);
    if(action==='stop') await provider.cancelAndWait(sid);
    else if(action==='end') await provider.endSession(sid);
    else if(action==='fresh') await provider.createSession({sessionKey:key,cwd:dir,fresh:true});
    else await provider.disconnect();
    finish({userStepIndex:0,responseStepIndex:1,text:'MUST NOT APPEAR'});
    await new Promise(resolve=>setTimeout(resolve,30));
    expect(completes).toHaveLength(0);
    expect(deltas).toHaveLength(0);
    expect(errors.every(([,e])=>e.code===PROVIDER_ERROR_CODES.CANCELLED)).toBe(true);
    if(action==='stop'||action==='fresh') {
      await provider.send(sid,'new turn');
      await waitFor(()=>completes.length===1);
      expect(completes[0][1].content).toBe('Hello');
    }
  });

  it('Stop wins over a late history read even after the CLI has already physically exited', async () => {
    let finish!: (value: {userStepIndex:number;responseStepIndex:number;text:string}) => void;
    const read=vi.spyOn(AgyHistoryReader.prototype,'read').mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    const sid=await provider.createSession({sessionKey:'exited-reader',cwd:dir,resumeId:'11111111-1111-4111-8111-111111111111'});
    await provider.send(sid,'QUOTA_EMPTY_EXIT');
    await waitFor(()=>read.mock.calls.length===1);
    const states=(provider as unknown as {sessions:Map<string,{child:{exitCode:number|null}|null}>}).sessions;
    await waitFor(()=>states.get(sid)?.child?.exitCode===0);
    await provider.cancelAndWait(sid);
    await provider.send(sid,'next turn after the confirmed physical exit');
    await waitFor(()=>completes.length===1);
    expect(completes[0][1].content).toBe('Hello');
    expect(provider.getSessionDiagnostics(sid)).toMatchObject({inflightTurns:0});
    finish({userStepIndex:0,responseStepIndex:1,text:'MUST NOT APPEAR'});
    await new Promise(resolve=>setTimeout(resolve,30));
    expect(completes).toHaveLength(1);
    expect(deltas.every(([,delta])=>!delta.delta.includes('MUST NOT APPEAR'))).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it('preserves the listener-bound state and input evidence when an existing session is rebound', async () => {
    let finish!: (value: {userStepIndex:number;responseStepIndex:number;text:string}) => void;
    const read=vi.spyOn(AgyHistoryReader.prototype,'read').mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    const config={sessionKey:'rebound',cwd:dir,resumeId:'11111111-1111-4111-8111-111111111111'};
    const sid=await provider.createSession(config);
    await provider.send(sid,'QUOTA_EMPTY');
    await waitFor(()=>read.mock.calls.length===1);
    expect(await provider.createSession(config)).toBe(sid);
    finish({userStepIndex:0,responseStepIndex:1,text:'Recovered bound turn'});
    await waitFor(()=>completes.length===1);
    await provider.send(sid,'next');
    await waitFor(()=>completes.length===2);
    expect(completes.map(([,m])=>m.content)).toEqual(['Recovered bound turn','Hello']);
    expect(launches()).toHaveLength(1);
    expect(provider.getSessionDiagnostics(sid)).toMatchObject({inflightTurns:0});
  });

  it('does not infer historical quota on a fresh conversation, but can recover after an observed quota failure', async () => {
    const sid = await provider.createSession({ sessionKey: 'quota-fresh', cwd: dir, fresh: true });
    await provider.send(sid, 'QUOTA_STALE');
    await waitFor(() => errors.length === 1);
    expect(completes).toHaveLength(0);
    await provider.send(sid, 'QUOTA_STALE');
    await waitFor(() => errors.length + completes.length === 2);
    expect(errors).toHaveLength(1);
    expect(completes[0][1].content).toBe('Hello');
    expect(launches()).toHaveLength(1);
  });

  it('recognizes a completed tool turn when result.response includes earlier assistant steps', async () => {
    const sid = await provider.createSession({ sessionKey: 'quota-multistep', cwd: dir, resumeId: 'existing-conversation' });
    await provider.send(sid, 'QUOTA_MULTISTEP');
    await waitFor(() => completes.length + errors.length === 1);
    expect(errors).toHaveLength(0);
    expect(completes[0][1].content).toBe('Hello');
    expect(tools.map(([, tool]) => tool.status)).toEqual(['running', 'complete']);
  });

  it('keeps per-turn evidence isolated when queued inputs include a new quota failure between successes', async () => {
    const sid = await provider.createSession({ sessionKey: 'quota-queued', cwd: dir, resumeId: 'existing-conversation' });
    await provider.send(sid, 'QUOTA_STALE');
    await provider.send(sid, 'QUOTA_EMPTY');
    await provider.send(sid, 'QUOTA_COMPLETED_TOOL');
    await waitFor(() => completes.length + errors.length === 3);
    expect(completes.map(([, m]) => m.content)).toEqual(['Hello', 'Hello']);
    expect(errors).toHaveLength(1);
    expect(errors[0][1].code).toBe(PROVIDER_ERROR_CODES.RATE_LIMITED);
    expect(launches()).toHaveLength(1);
    expect(provider.getSessionDiagnostics(sid)).toMatchObject({ inflightTurns: 0 });
  });

  it.each([
    'QUOTA_EMPTY', 'QUOTA_PARTIAL', 'QUOTA_TOOL', 'QUOTA_CURRENT_ERROR',
    'QUOTA_DETAILS', 'QUOTA_MISMATCH', 'QUOTA_ACTIVE_AFTER_DONE',
    'QUOTA_NO_BOUNDARY', 'QUOTA_NO_INDEX', 'QUOTA_OLD_RESPONSE', 'QUOTA_NEW_FAILURE',
    'QUOTA_CURRENT_ERROR_NO_INDEX_ERROR',
  ])('preserves a real or unproven current failure: %s', async (prompt) => {
    const sid = await provider.createSession({ sessionKey: prompt, cwd: dir, resumeId: 'existing-conversation' });
    await provider.send(sid, prompt);
    await waitFor(() => completes.length + errors.length === 1);
    expect(completes).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0][1].message).toContain(prompt === 'QUOTA_NEW_FAILURE' ? 'unauthorized' : 'Individual quota reached');
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
    expect(completes[0][1].metadata?.usage).toEqual({
      input_tokens: 120,
      output_tokens: 25,
      cache_read_input_tokens: undefined,
    });
  });

  it('emits live step usage and finalized turn usage for context window syncing', async () => {
    const sid = await provider.createSession({ sessionKey: 's-usage', cwd: dir, agentId: 'gemini-3.8-flash-high' });
    await provider.send(sid, 'say hello');
    await waitFor(() => completes.length === 1);

    expect(usages.length).toBeGreaterThanOrEqual(2);
    // Live step usage
    const stepUsage = usages.find(([, u]) => u.finalized === false);
    expect(stepUsage).toBeDefined();
    expect(stepUsage![1].usage).toMatchObject({
      input_tokens: 5,
      output_tokens: 2,
    });
    expect(stepUsage![1].model).toBe('gemini-3.8-flash-high');

    // Finalized result usage
    const finalUsage = usages.find(([, u]) => u.finalized === true);
    expect(finalUsage).toBeDefined();
    expect(finalUsage![1].usage).toMatchObject({
      input_tokens: 5,
      output_tokens: 2,
      cache_read_input_tokens: 7,
    });
    expect(finalUsage![1].model).toBe('gemini-3.8-flash-high');

    // Completion message metadata matches prompt context usage
    expect(completes[0][1].metadata?.usage).toMatchObject({
      input_tokens: 5,
      output_tokens: 2,
      cache_read_input_tokens: 7,
    });
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

  it('cancelAndWait confirms child exit and next send resumes the conversation', async () => {
    const sid = await provider.createSession({ sessionKey: 's5-wait', cwd: dir });
    await provider.send(sid, 'HANG');
    await waitFor(() => infos.length > 0);
    const convId = infos[0][1].resumeId!;
    await provider.cancelAndWait(sid);
    expect(errors.some(([, e]) => e.code === PROVIDER_ERROR_CODES.CANCELLED)).toBe(true);
    await provider.send(sid, 'resumed-after-cancel-and-wait');
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
    expect(first.models.map((m) => m.id)).toEqual(['claude-sonnet-5-5-low', 'gemini-3.8-flash-high']);
    expect(first.defaultModel).toBe('gemini-3.8-flash-high');
    await provider.listModels();
    const modelProbes = readFileSync(argsFile, 'utf8').trim().split('\n').filter((l) => l.includes('"models"'));
    expect(modelProbes).toHaveLength(1);
    await provider.listModels(true);
    expect(readFileSync(argsFile, 'utf8').trim().split('\n').filter((l) => l.includes('"models"'))).toHaveLength(2);
  });

  it('uses an advertised model as the catalog fallback when the preferred model is unavailable', async () => {
    writeFileSync(path.join(dir, 'agy'), FAKE_AGY.replaceAll('gemini-3.8-flash-high', 'gemini-4-argon-medium'));
    const list = await provider.listModels(true);
    expect(list.defaultModel).toBe('claude-sonnet-5-5-low');
    expect(list.models.map((model) => model.id)).toContain(list.defaultModel);
  });

  it('reports a config error when the binary is missing', async () => {
    const broken = new AgySdkProvider();
    await expect(broken.connect({ binaryPath: path.join(dir, 'does-not-exist') }))
      .rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.CONFIG_ERROR });
    expect(await broken.listModels()).toMatchObject({ models: [], isAuthenticated: false });
  });

  it('emits subagent tool call with normalized SdkSubagentDetail for invoke_subagent', async () => {
    const sid = await provider.createSession({ sessionKey: 'subagent-sess', cwd: dir });
    const toolEvents: ToolCallEvent[] = [];
    provider.onToolCall((_s, tool) => toolEvents.push(tool));
    await provider.send(sid, 'SUBAGENT run');
    await waitFor(() => completes.length === 1);

    const subagentCalls = toolEvents.filter((t) => t.detail?.kind === SDK_SUBAGENT_DETAIL_KIND);
    expect(subagentCalls.length).toBeGreaterThanOrEqual(1);
    const subagentCall = subagentCalls[subagentCalls.length - 1];
    expect(subagentCall.name).toBe('invoke_subagent');
    expect(subagentCall.detail).toMatchObject({
      kind: SDK_SUBAGENT_DETAIL_KIND,
      summary: 'Antigravity sub-agent Researcher',
      meta: {
        isSdkSubagent: true,
        provider: SDK_SUBAGENT_PROVIDERS.AGY_SDK,
        providerKind: SDK_SUBAGENT_PROVIDER_KINDS.AGY_RUNTIME_AGENT,
        normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
        active: false,
        terminal: true,
        backgrounded: true,
      },
    });
  });
});
