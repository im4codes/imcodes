import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const piHarness = vi.hoisted(() => ({
  spawns: [] as Array<{ cmd: string; args: string[]; env: Record<string, string | undefined> }>,
  turns: [] as string[],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn((cmd: string, args: string[], opts: { env?: Record<string, string | undefined> }) => {
      piHarness.spawns.push({ cmd, args: [...args], env: { ...(opts?.env ?? {}) } });
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        stdin: EventEmitter & { destroyed: boolean; write: (chunk: string) => boolean };
        killed: boolean;
        pid: number;
        kill: () => boolean;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.pid = 90000 + piHarness.spawns.length;
      const emitFrame = (frame: Record<string, unknown>) => {
        child.stdout.write(`${JSON.stringify(frame)}\n`);
      };
      child.stdin = Object.assign(new EventEmitter(), {
        destroyed: false,
        write: (chunk: string) => {
          const command = JSON.parse(chunk.trim()) as { id?: string; type: string; message?: string };
          setImmediate(() => {
            if (command.type === 'get_state') {
              emitFrame({
                type: 'response',
                id: command.id,
                command: 'get_state',
                success: true,
                data: {
                  sessionId: 'ephemeral-pi-sid',
                  model: { id: 'MiniMax-M2.7', provider: 'minimax' },
                  thinkingLevel: 'medium',
                },
              });
              return;
            }
            if (command.type === 'prompt') {
              const text = String(command.message ?? '');
              piHarness.turns.push(text);
              emitFrame({ type: 'response', id: command.id, command: 'prompt', success: true });
              emitFrame({ type: 'agent_start' });
              emitFrame({
                type: 'message_update',
                assistantMessageEvent: { type: 'text_delta', delta: `PI-REPLY:${text}` },
              });
              emitFrame({
                type: 'message_end',
                message: {
                  role: 'assistant',
                  model: 'MiniMax-M2.7',
                  content: [{ type: 'text', text: `PI-REPLY:${text}` }],
                  usage: { input: 11, output: 4 },
                  stopReason: 'stop',
                },
              });
              emitFrame({ type: 'agent_settled' });
              return;
            }
            emitFrame({ type: 'response', id: command.id, command: command.type, success: true });
          });
          return true;
        },
      });
      child.kill = () => {
        child.killed = true;
        setImmediate(() => {
          child.emit('exit', 0, null);
          child.emit('close', 0, null);
        });
        return true;
      };
      return child as never;
    }),
  };
});

vi.mock('../../src/util/kill-process-tree.js', () => ({
  killProcessTree: vi.fn(async (child: { kill?: () => void }) => { child.kill?.(); }),
}));

import {
  SESSION_INCOGNITO_MEMORY_DISABLED,
  supportsSessionIncognito,
} from '../../shared/session-incognito-types.js';
import { PI_MCP_CONFIG_ENV } from '../../shared/pi-agent.js';
import { setSessionIncognito } from '../../shared/session-incognito-context.js';
import { handleWebCommand, handoffSessionConversation, type ServerLink } from '../../src/daemon/command-handler.js';
import {
  stopProject,
  getTransportRuntime,
  relaunchSessionWithSettings,
  restoreTransportSessions,
  resetProviderRegistryForTests,
} from '../../src/agent/session-manager.js';
import { piSessionDir } from '../../src/agent/providers/pi/runtime.js';
import { resetSessionStoreAuthorityForTests, loadStore, flushStore, getSession, removeSession } from '../../src/store/session-store.js';
import { getTransportQueueStore, resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';
import { timelineStore } from '../../src/daemon/timeline-store.js';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';
import { replayTransportHistory } from '../../src/daemon/transport-history.js';
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';

async function waitFor(fn: () => boolean, timeoutMs = 4000, describeFailure?: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(describeFailure ? describeFailure() : 'Timed out waiting for condition');
}

describe('daemon Pi incognito end-to-end lifecycle', () => {
  let tempHome = '';
  let workDir = '';
  let prevHome: string | undefined;
  let prevImcodesHome: string | undefined;
  let prevPiMcpConfig: string | undefined;

  beforeEach(async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'pi-incognito-e2e-'));
    workDir = join(tempHome, 'proj');
    mkdirSync(workDir, { recursive: true });
    prevHome = process.env.HOME;
    prevImcodesHome = process.env.IMCODES_HOME;
    prevPiMcpConfig = process.env[PI_MCP_CONFIG_ENV];
    process.env.HOME = tempHome;
    process.env.IMCODES_HOME = join(tempHome, '.imcodes');
    process.env[PI_MCP_CONFIG_ENV] = JSON.stringify({ command: 'node', args: ['inherited.js'], env: {} });
    piHarness.spawns.length = 0;
    piHarness.turns.length = 0;
    resetProviderRegistryForTests?.();
    resetTransportQueueStoreForTests();
    resetSessionStoreAuthorityForTests();
    await loadStore();
  });

  afterEach(async () => {
    setSessionIncognito('deck_pipriv_brain', false);
    removeSession('deck_pipriv_brain');
    timelineEmitter.forgetSession('deck_pipriv_brain');
    resetTransportQueueStoreForTests();
    await flushStore().catch(() => {});
    process.env.HOME = prevHome;
    if (prevImcodesHome === undefined) delete process.env.IMCODES_HOME;
    else process.env.IMCODES_HOME = prevImcodesHome;
    if (prevPiMcpConfig === undefined) delete process.env[PI_MCP_CONFIG_ENV];
    else process.env[PI_MCP_CONFIG_ENV] = prevPiMcpConfig;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('reports supportsSessionIncognito("pi") === true and enforces full privacy guarantees', async () => {
    expect(supportsSessionIncognito('pi')).toBe(true);

    const sent: Array<Record<string, unknown>> = [];
    const emittedEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const off = timelineEmitter.on((ev) => {
      if (ev.sessionId === 'deck_pipriv_brain') {
        emittedEvents.push({ type: ev.type, payload: ev.payload });
      }
    });

    const link = {
      send: (msg: Record<string, unknown>) => sent.push(msg),
      supportsIncognitoSessions: () => true,
      sendTimelineEvent: vi.fn(),
    } as unknown as ServerLink;

    try {
      // 1. Launch incognito Pi main session
      handleWebCommand({
        type: 'session.start',
        project: 'pipriv',
        dir: workDir,
        agentType: 'pi',
        incognito: true,
      }, link);

      await waitFor(() => {
        const err = sent.find((m) => m.type === 'session.error');
        if (err) throw new Error(`Unexpected session.error: ${JSON.stringify(err)}`);
        return Boolean(getTransportRuntime('deck_pipriv_brain'));
      });

      const privRecord = getSession('deck_pipriv_brain');
      expect(privRecord?.incognito).toBe(true);
      expect(privRecord?.providerResumeId).toBeUndefined();

      // 2. RAM-only queue does not write to transport-queue.sqlite
      const queueStore = getTransportQueueStore();
      const recipient = (getTransportRuntime('deck_pipriv_brain') as unknown as { recipientIdentity?: { sessionInstanceId: string; runtimeEpoch: string } })?.recipientIdentity;
      queueStore.enqueue({
        sessionName: 'deck_pipriv_brain',
        recipient,
        clientMessageId: 'pi-priv-q-1',
        text: 'SECRET-PI-QUEUED',
      });
      queueStore.cancelQueuedMessage('deck_pipriv_brain', 'pi-priv-q-1', recipient);
      const diskQueuePath = join(process.env.IMCODES_HOME!, 'transport-queue.sqlite');
      if (existsSync(diskQueuePath)) {
        expect(readFileSync(diskQueuePath).toString('utf8')).not.toContain('SECRET-PI-QUEUED');
      }

      // 3. Drive 2 live turns on the same incognito Pi child
      handleWebCommand({
        type: 'session.send',
        sessionName: 'deck_pipriv_brain',
        text: 'SECRET-PI-ONE',
        commandId: 'cmd-pi-1',
      }, link);
      await waitFor(() => emittedEvents.some((e) => e.type === 'assistant.text' && String(e.payload.text ?? '').includes('PI-REPLY:') && String(e.payload.text ?? '').includes('SECRET-PI-ONE') && e.payload.streaming === false));

      handleWebCommand({
        type: 'session.send',
        sessionName: 'deck_pipriv_brain',
        text: 'SECRET-PI-TWO',
        commandId: 'cmd-pi-2',
      }, link);
      await waitFor(() => emittedEvents.some((e) => e.type === 'assistant.text' && String(e.payload.text ?? '').includes('SECRET-PI-TWO') && e.payload.streaming === false));

      expect(piHarness.spawns).toHaveLength(1);
      const firstSpawn = piHarness.spawns[0]!;
      expect(firstSpawn.args).toContain('--no-session');
      expect(firstSpawn.args).not.toContain('--session-id');
      expect(firstSpawn.args).not.toContain('--session-dir');
      expect(firstSpawn.args).not.toContain('--name');
      expect(firstSpawn.env[PI_MCP_CONFIG_ENV]).toBeUndefined();
      expect(getSession('deck_pipriv_brain')?.providerResumeId).toBeUndefined();

      // 4. Memory MCP tool handler refuses calls for incognito session
      const handlers = createMemoryMcpToolHandlers({
        userId: 'u',
        sessionName: 'deck_pipriv_brain',
        projectName: 'pipriv',
        projectRoot: workDir,
      });
      const obsRes = await handlers.save_observation({ content: 'SECRET-PI-OBS', toolSummary: 'Save' } as any);
      expect(JSON.stringify(obsRes)).toContain(SESSION_INCOGNITO_MEMORY_DISABLED);

      // 5. Non-resumable / non-handoffable while incognito & skipped by restoreTransportSessions
      await expect(relaunchSessionWithSettings(getSession('deck_pipriv_brain')!, { fresh: false })).rejects.toThrow('Incognito conversation ended');
      await expect(handoffSessionConversation(getSession('deck_pipriv_brain')!, link)).rejects.toThrow('do not support cross-vendor handoff');
      await restoreTransportSessions({ sessionName: 'deck_pipriv_brain' });
      expect(piHarness.spawns).toHaveLength(1);

      // 6. Zero files written under piSessionDir(), timelineStore, or transport-history
      expect(existsSync(piSessionDir())).toBe(false);
      await timelineStore.flushSession('deck_pipriv_brain');
      await flushStore();
      expect(await replayTransportHistory('deck_pipriv_brain')).toEqual([]);
      expect(timelineStore.read('deck_pipriv_brain')).toEqual([]);

      // 7. Stop clears RAM state
      await stopProject('pipriv', link);
      expect(getSession('deck_pipriv_brain')).toBeUndefined();
      const remaining = timelineEmitter.getBufferedEvents('deck_pipriv_brain');
      expect(JSON.stringify(remaining)).not.toContain('SECRET-PI');

      // 8. Re-launching a normal Pi session with the same project name restores standard persistence
      handleWebCommand({
        type: 'session.start',
        project: 'pipriv',
        dir: workDir,
        agentType: 'pi',
      }, link);
      await waitFor(() => Boolean(getTransportRuntime('deck_pipriv_brain')));
      expect(getSession('deck_pipriv_brain')?.incognito).not.toBe(true);

      handleWebCommand({
        type: 'session.send',
        sessionName: 'deck_pipriv_brain',
        text: 'ORDINARY-PI-TURN',
        commandId: 'cmd-pi-norm',
      }, link);
      await waitFor(() => emittedEvents.some((e) => e.type === 'assistant.text' && String(e.payload.text ?? '').includes('PI-REPLY:') && String(e.payload.text ?? '').includes('ORDINARY-PI-TURN') && e.payload.streaming === false));

      const secondSpawn = piHarness.spawns[1]!;
      expect(secondSpawn.args).toContain('--session-id');
      expect(secondSpawn.args).toContain('--session-dir');
      expect(secondSpawn.args).not.toContain('--no-session');
      expect(secondSpawn.env[PI_MCP_CONFIG_ENV]).toBeDefined();

      await timelineStore.flushSession('deck_pipriv_brain');
      const replayedNormal = await replayTransportHistory('deck_pipriv_brain');
      expect(replayedNormal.some((e) => e.text.includes('ORDINARY-PI-TURN'))).toBe(true);
      expect(JSON.stringify(replayedNormal)).not.toContain('SECRET-PI');
    } finally {
      off();
    }
  });
});
