import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGY_NATIVE_SESSION_STATE, AGY_SDK_PROVIDER_ID, AGY_STREAM_INTERRUPTED_ERROR } from '../../shared/agy-agent.js';
import { isKnownTestSessionLike } from '../../shared/test-session-guard.js';
import { connectProvider, disconnectAll } from '../../src/agent/provider-registry.js';
import {
  getTransportRuntime,
  launchTransportSession,
  stopTransportRuntimeSession,
} from '../../src/agent/session-manager.js';
import { PROVIDER_ERROR_CODES } from '../../src/agent/transport-provider.js';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';
import type { TimelineEvent } from '../../src/daemon/timeline-event.js';
import { replayTransportHistory } from '../../src/daemon/transport-history.js';
import { getSession, removeSession } from '../../src/store/session-store.js';

const CONV_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_NAME = 'deck_e2e_agy_hist_err_brain';
const PROJECT_NAME = 'e2e_agy_hist_err';
const FIXTURE_PATH = path.resolve(import.meta.dirname, '../fixtures/agy-native-history/fixture.cjs');

describe('AGY historical error multi-turn E2E (TransportSessionRuntime -> wireProviderToRelay -> timelineEmitter)', () => {
  let tempDir: string;
  let logPath: string;
  let unsubscribeTimeline: (() => void) | undefined;
  let observedTimelineEvents: TimelineEvent[];

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'imcodes-e2e-agy-hist-'));
    logPath = path.join(tempDir, 'cli-invocations.jsonl');
    observedTimelineEvents = [];

    expect(isKnownTestSessionLike({
      name: SESSION_NAME,
      projectName: PROJECT_NAME,
      projectDir: tempDir,
    })).toBe(true);

    unsubscribeTimeline = timelineEmitter.on((event) => {
      if (event.sessionId === SESSION_NAME) {
        observedTimelineEvents.push(event);
      }
    });

    const fakeCli = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const logFile = ${JSON.stringify(logPath)};
if (args[0] === '--help') {
  process.stdout.write('Usage of agy:\\n');
  process.exit(0);
}
fs.appendFileSync(logFile, JSON.stringify({ kind: 'spawn', args }) + '\\n');
const resumeIdx = args.indexOf('--conversation');
const convId = resumeIdx >= 0 ? args[resumeIdx + 1] : ${JSON.stringify(CONV_ID)};
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
emit({
  event: 'init',
  conversation_id: convId,
  init: { cwd: process.cwd(), tools: [], permission_mode: 'always-proceed' },
});
let step = 0;
let buf = '';
const STREAM_ERR = ${JSON.stringify(AGY_STREAM_INTERRUPTED_ERROR)};
process.stdin.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const parsed = JSON.parse(line);
    const text = parsed?.message?.content ?? '';
    fs.appendFileSync(logFile, JSON.stringify({ kind: 'stdin', text }) + '\\n');
    if (text.includes('TURN4_DB_ONLY_STALE_ERR')) {
      const { persist, STREAM_ERROR } = require(${JSON.stringify(FIXTURE_PATH)});
      persist(process.env.HOME || ${JSON.stringify(tempDir)}, text, {
        error: STREAM_ERROR,
        historicalStatus: 3,
        answer: 'Turn 4 DB-recovered reply without error',
      });
      emit({
        event: 'result',
        result: {
          conversation_id: convId,
          status: 'ERROR',
          response: '',
          error: STREAM_ERR,
          num_turns: 1,
          usage: { input_tokens: 34, output_tokens: 9 },
        },
      });
      continue;
    }
    emit({
      event: 'step_update',
      step_update: { conversation_id: convId, step_index: step++, state: 'DONE', step_type: 'user_input' },
    });
    const idx = step++;
    if (text.includes('TURN1_INTERRUPTED')) {
      emit({
        event: 'step_update',
        step_update: {
          conversation_id: convId,
          step_index: idx,
          state: 'ACTIVE',
          step_type: 'agent_response',
          text_delta: 'Partial turn 1 output',
        },
      });
      emit({
        event: 'step_update',
        step_update: {
          conversation_id: convId,
          step_index: step++,
          state: 'DONE',
          step_type: 'system_error',
          text_delta: STREAM_ERR,
        },
      });
      emit({
        event: 'result',
        result: {
          conversation_id: convId,
          status: 'ERROR',
          response: 'Partial turn 1 output',
          error: STREAM_ERR,
          num_turns: 1,
          usage: { input_tokens: 12, output_tokens: 5 },
        },
      });
      continue;
    }
    if (text.includes('TURN2_COMPLETE_WITH_STALE_ERR')) {
      const reply = 'Turn 2 complete reply without error';
      emit({
        event: 'step_update',
        step_update: {
          conversation_id: convId,
          step_index: idx,
          state: 'ACTIVE',
          step_type: 'agent_response',
          text_delta: reply,
        },
      });
      emit({
        event: 'step_update',
        step_update: {
          conversation_id: convId,
          step_index: idx,
          state: 'DONE',
          step_type: 'agent_response',
          text_delta: '\\n',
        },
      });
      emit({
        event: 'result',
        result: {
          conversation_id: convId,
          status: 'ERROR',
          response: reply + '\\n',
          error: STREAM_ERR,
          num_turns: 1,
          usage: { input_tokens: 20, output_tokens: 8 },
        },
      });
      continue;
    }
    if (text.includes('TURN3_COMPLETE_WITH_QUOTED_ERR')) {
      const reply = 'Turn 3 normal text quoting Error: ' + STREAM_ERR;
      emit({
        event: 'step_update',
        step_update: {
          conversation_id: convId,
          step_index: idx,
          state: 'ACTIVE',
          step_type: 'agent_response',
          text_delta: reply,
        },
      });
      emit({
        event: 'step_update',
        step_update: {
          conversation_id: convId,
          step_index: idx,
          state: 'DONE',
          step_type: 'agent_response',
          text_delta: '\\n',
        },
      });
      emit({
        event: 'result',
        result: {
          conversation_id: convId,
          status: 'ERROR',
          response: reply + '\\n',
          error: STREAM_ERR,
          num_turns: 1,
          usage: { input_tokens: 28, output_tokens: 14 },
        },
      });
      continue;
    }
    if (text.includes('TURN5_GENUINE_EMPTY_FAIL')) {
      emit({
        event: 'step_update',
        step_update: {
          conversation_id: convId,
          step_index: step++,
          state: 'DONE',
          step_type: 'system_error',
          text_delta: STREAM_ERR,
        },
      });
      emit({
        event: 'result',
        result: {
          conversation_id: convId,
          status: 'ERROR',
          response: '',
          error: STREAM_ERR,
          num_turns: 1,
          usage: { input_tokens: 40, output_tokens: 0 },
        },
      });
      continue;
    }
  }
});
`;
    const binPath = path.join(tempDir, 'agy');
    writeFileSync(binPath, fakeCli, 'utf8');
    chmodSync(binPath, 0o755);

    await connectProvider(AGY_SDK_PROVIDER_ID, {
      binaryPath: binPath,
      env: { HOME: tempDir },
    });
    await launchTransportSession({
      name: SESSION_NAME,
      projectName: PROJECT_NAME,
      role: 'brain',
      agentType: AGY_SDK_PROVIDER_ID,
      projectDir: tempDir,
    });
  });

  afterEach(async () => {
    unsubscribeTimeline?.();
    unsubscribeTimeline = undefined;
    await stopTransportRuntimeSession(SESSION_NAME);
    removeSession(SESSION_NAME);
    await disconnectAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('drives real TransportSessionRuntime -> wireProviderToRelay -> timelineEmitter & transport-history across stream failure, stale-error suppression, quoted-error preservation, SQLite DB recovery, and genuine failure', async () => {
    const emitSpy = vi.spyOn(timelineEmitter, 'emit');
    try {
      const runtime = getTransportRuntime(SESSION_NAME);
      expect(runtime).toBeDefined();
      expect(getSession(SESSION_NAME)?.agyNativeSessionState).toBe(AGY_NATIVE_SESSION_STATE.UNSTARTED);

      const finalizedAssistantEvents = () =>
        observedTimelineEvents.filter(
          (e) => e.type === 'assistant.text' && e.payload.streaming === false,
        );

      // ── Turn 1: real stream interruption after partial text ──────────────────
      runtime!.send('TURN1_INTERRUPTED', 'msg-turn-1');
      await vi.waitFor(() => {
        expect(finalizedAssistantEvents()).toHaveLength(1);
        expect(runtime!.getStatus()).toBe('idle');
      });

      const turn1Event = finalizedAssistantEvents()[0]!;
      expect(turn1Event.payload.text).toBe(
        `Partial turn 1 output\n\n⚠️ Error: ${AGY_STREAM_INTERRUPTED_ERROR}`,
      );
      expect(turn1Event.payload.memoryExcluded).toBe(true);
      expect(turn1Event.payload.providerErrorCode).toBe(PROVIDER_ERROR_CODES.PROVIDER_ERROR);
      expect(turn1Event.payload.providerErrorRecoverable).toBe(true);
      expect(getSession(SESSION_NAME)?.state).toBe('idle');
      expect(getSession(SESSION_NAME)?.providerResumeId).toBe(CONV_ID);
      expect(getSession(SESSION_NAME)?.agyNativeSessionState).toBe(AGY_NATIVE_SESSION_STATE.STARTED);

      // ── Turn 2: complete DONE reply carrying historical stream-interrupted error ──
      runtime!.send('TURN2_COMPLETE_WITH_STALE_ERR', 'msg-turn-2');
      await vi.waitFor(() => {
        expect(finalizedAssistantEvents()).toHaveLength(2);
        expect(runtime!.getStatus()).toBe('idle');
      });

      const turn2Event = finalizedAssistantEvents()[1]!;
      expect(turn2Event.payload.text).toBe('Turn 2 complete reply without error');
      expect(turn2Event.payload.providerErrorCode).toBeUndefined();
      expect(turn2Event.payload.memoryExcluded).toBeUndefined();
      expect(getSession(SESSION_NAME)?.state).toBe('idle');
      expect(getSession(SESSION_NAME)?.providerResumeId).toBe(CONV_ID);

      // ── Turn 3: complete DONE reply whose own assistant text quotes the error string ──
      runtime!.send('TURN3_COMPLETE_WITH_QUOTED_ERR', 'msg-turn-3');
      await vi.waitFor(() => {
        expect(finalizedAssistantEvents()).toHaveLength(3);
        expect(runtime!.getStatus()).toBe('idle');
      });

      const turn3Event = finalizedAssistantEvents()[2]!;
      expect(turn3Event.payload.text).toBe(
        `Turn 3 normal text quoting Error: ${AGY_STREAM_INTERRUPTED_ERROR}`,
      );
      expect(turn3Event.payload.providerErrorCode).toBeUndefined();
      expect(getSession(SESSION_NAME)?.state).toBe('idle');
      expect(getSession(SESSION_NAME)?.providerResumeId).toBe(CONV_ID);

      // ── Turn 4: DB-only recovery with empty stdout response + real SQLite disk roundtrip ──
      runtime!.send('TURN4_DB_ONLY_STALE_ERR', 'msg-turn-4');

      await vi.waitFor(() => {
        expect(finalizedAssistantEvents()).toHaveLength(4);
        expect(runtime!.getStatus()).toBe('idle');
      });

      const turn4Event = finalizedAssistantEvents()[3]!;
      expect(turn4Event.payload.text).toBe('Turn 4 DB-recovered reply without error');
      expect(turn4Event.payload.providerErrorCode).toBeUndefined();
      expect(getSession(SESSION_NAME)?.state).toBe('idle');
      expect(getSession(SESSION_NAME)?.providerResumeId).toBe(CONV_ID);

      // ── Turn 5: genuine current-turn failure with identical error text ──────
      runtime!.send('TURN5_GENUINE_EMPTY_FAIL', 'msg-turn-5');
      await vi.waitFor(() => {
        expect(finalizedAssistantEvents()).toHaveLength(5);
        expect(runtime!.getStatus()).toBe('idle');
      });

      const turn5Event = finalizedAssistantEvents()[4]!;
      expect(turn5Event.payload.text).toBe(`⚠️ Error: ${AGY_STREAM_INTERRUPTED_ERROR}`);
      expect(turn5Event.payload.memoryExcluded).toBe(true);
      expect(turn5Event.payload.providerErrorCode).toBe(PROVIDER_ERROR_CODES.PROVIDER_ERROR);
      expect(turn5Event.payload.providerErrorRecoverable).toBe(true);
      expect(getSession(SESSION_NAME)?.state).toBe('idle');
      expect(getSession(SESSION_NAME)?.providerResumeId).toBe(CONV_ID);

      // ── Verify real timelineEmitter buffer/replay and real transport-history JSONL ──
      const { events: replayedTimeline } = timelineEmitter.replay(SESSION_NAME, 0);
      const replayedFinalTexts = replayedTimeline
        .filter((e) => e.type === 'assistant.text' && e.payload.streaming === false)
        .map((e) => e.payload.text);
      expect(replayedFinalTexts).toEqual([
        `Partial turn 1 output\n\n⚠️ Error: ${AGY_STREAM_INTERRUPTED_ERROR}`,
        'Turn 2 complete reply without error',
        `Turn 3 normal text quoting Error: ${AGY_STREAM_INTERRUPTED_ERROR}`,
        'Turn 4 DB-recovered reply without error',
        `⚠️ Error: ${AGY_STREAM_INTERRUPTED_ERROR}`,
      ]);

      await vi.waitFor(async () => {
        const historyEvents = await replayTransportHistory(SESSION_NAME);
        const assistantHistoryTexts = historyEvents
          .filter((e) => e.type === 'assistant.text')
          .map((e) => e.text);
        expect(assistantHistoryTexts).toEqual([
          'Turn 2 complete reply without error',
          `Turn 3 normal text quoting Error: ${AGY_STREAM_INTERRUPTED_ERROR}`,
          'Turn 4 DB-recovered reply without error',
        ]);
      });

      // ── Verify no duplicate send, no fresh reset, single process spawn ──────
      const cliLog = readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { kind: string; args?: string[]; text?: string });
      const spawns = cliLog.filter((entry) => entry.kind === 'spawn');
      const stdinTurns = cliLog.filter((entry) => entry.kind === 'stdin');
      expect(spawns).toHaveLength(1);
      expect(stdinTurns).toHaveLength(5);
      expect(stdinTurns.map((entry) => entry.text)).toEqual([
        expect.stringContaining('TURN1_INTERRUPTED'),
        expect.stringContaining('TURN2_COMPLETE_WITH_STALE_ERR'),
        expect.stringContaining('TURN3_COMPLETE_WITH_QUOTED_ERR'),
        expect.stringContaining('TURN4_DB_ONLY_STALE_ERR'),
        expect.stringContaining('TURN5_GENUINE_EMPTY_FAIL'),
      ]);
      expect(emitSpy).toHaveBeenCalled();
    } finally {
      emitSpy.mockRestore();
    }
  });
});
