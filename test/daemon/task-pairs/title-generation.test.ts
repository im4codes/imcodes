/**
 * Task pair titles: when none was explicitly authored, a short title is
 * generated in the project Brain's configured UI locale, from the QUEUE
 * brief, the send_message objective, or (back-fill) a known generic
 * placeholder -- reusing the `uiLocale` field the retired legacy supervision
 * prompts used for the same purpose (shared/supervision-config.ts). See
 * src/daemon/task-pairs/title-generator.ts and the hooks in service.ts /
 * send-tool.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../../src/store/session-store.js';
import { getSession, removeSession, upsertSession } from '../../../src/store/session-store.js';
import { timelineEmitter } from '../../../src/daemon/timeline-emitter.js';
import { TaskPairStore, setTaskPairStoreForTests, getTaskPairStore } from '../../../src/daemon/task-pairs/store.js';
import { brainUiLocale } from '../../../src/daemon/task-pairs/engine.js';
import { setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { TaskPairService, taskPairService } from '../../../src/daemon/task-pairs/service.js';
import { dispatchSendMessage, clearSendIdempotencyCacheForTests } from '../../../src/daemon/send-tool.js';
import { handleWebCommand } from '../../../src/daemon/command-handler.js';
import { hasInvalidSessionSupervisionSnapshot, patchTransportConfigUiLocale, type SupervisionUiLocale } from '../../../shared/supervision-config.js';
import { TASK_PAIR_GENERIC_TITLE_PLACEHOLDERS, TASK_PAIR_TIMELINE_EVENT } from '../../../shared/task-pair.js';

const PROJECT = 'titleproj';
const BRAIN = 'deck_titleproj_brain';
const EXEC = 'deck_sub_titleexec';
const AUD = 'deck_sub_titleaud';

function session(name: string, role: SessionRecord['role'], extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name, projectName: PROJECT, role, agentType: 'claude-code-sdk', projectDir: `/tmp/${PROJECT}`, state: 'idle',
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`,
    restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1, ...extra,
  } as SessionRecord;
}

function setBrainLocale(locale: string | undefined): void {
  upsertSession(session(BRAIN, 'brain', {
    transportConfig: locale ? patchTransportConfigUiLocale(null, locale as SupervisionUiLocale) : undefined,
  }));
}

let service: TaskPairService;
let sent: Array<{ target: string; text: string; id: string }>;
let turn = 0;

async function say(sessionName: string, text: string, eventId?: string) {
  turn += 1;
  timelineEmitter.emit(sessionName, 'assistant.text', { text, streaming: false }, {
    source: 'daemon', confidence: 'high', eventId: eventId ?? `turn-${turn}`,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function pair(taskId: string) {
  return getTaskPairStore().getPair(PROJECT, taskId)?.state;
}

describe('task-pair title generation', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;

  beforeEach(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    sent = [];
    setTaskPairDeliveryDepsForTests({ send: async (target, text, id) => { sent.push({ target, text, id }); } });
    for (const record of [session(BRAIN, 'brain'), session(EXEC, 'w2'), session(AUD, 'w3')]) upsertSession(record);
    service = new TaskPairService();
    service.init();
  });

  afterEach(async () => {
    await service.dispose();
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    for (const name of [BRAIN, EXEC, AUD]) removeSession(name);
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  it('uses a localized placeholder and sends one batched Brain request for a titleless QUEUE', async () => {
    setBrainLocale('zh-CN');
    await say(BRAIN, [
      'Queueing.',
      '<!-- IMCODES_TASK QUEUE T1 -->',
      'Fix the login bug for SSO users.',
      '<!-- IMCODES_TASK_END T1 -->',
    ].join('\n'));
    await service.waitForIdle();
    expect(pair('T1')?.status).toBe('queued');
    expect(pair('T1')?.title).toBe('未命名任务');
    expect(sent.filter((entry) => entry.target === BRAIN)).toHaveLength(1);
    expect(sent[0]?.text).toContain('T1');
    expect(sent[0]?.text).toContain('title="Fix login retry"');
  });

  it('persists the browser UI locale before a titleless QUEUE and keeps an explicit title', async () => {
    const serverLink = { send: vi.fn() };
    handleWebCommand({ type: 'session.send', session: BRAIN, commandId: 'cmd-locale-1', uiLocale: 'zh-CN' }, serverLink as never);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await say(BRAIN, '<!-- IMCODES_TASK DISPATCH T2 executor=' + EXEC + ' auditor=' + AUD + ' title="Fix login" -->');
    expect(pair('T2')?.title).toBe('Fix login');
    expect(sent).toHaveLength(0);
  });

  it('uses a neutral non-id placeholder when no UI locale is configured', async () => {
    setBrainLocale(undefined);
    await say(BRAIN, [
      '<!-- IMCODES_TASK QUEUE T3 -->',
      'Some brief describing real work.',
      '<!-- IMCODES_TASK_END T3 -->',
    ].join('\n'));
    expect(pair('T3')?.title).toBe('(untitled task)');
    expect(pair('T3')?.title).not.toBe('T3');
  });

  it('updates an older generic placeholder when the locale arrives later', async () => {
    setBrainLocale(undefined);
    getTaskPairStore().savePair(PROJECT, {
      taskId: 'T12', brain: BRAIN, executor: EXEC, auditor: AUD, status: 'working',
      title: TASK_PAIR_GENERIC_TITLE_PLACEHOLDERS[0], flags: [], flagSides: {}, round: 0, blocking: [],
      previousAuditors: [], capCounts: {}, capRound: 0, createdAt: 1, updatedAt: 1,
    } as never);
    await say(BRAIN, 'First status update, before any locale is known.');
    expect(pair('T12')?.title).toBe(TASK_PAIR_GENERIC_TITLE_PLACEHOLDERS[0]);
    setBrainLocale('en');
    await say(BRAIN, 'Second status update, after the locale is known.');
    expect(pair('T12')?.title).toBe('Untitled task');
  });

  it('replaces raw-id and Brain-prefixed titles, but preserves a real title', async () => {
    setBrainLocale('en');
    await say(BRAIN, '<!-- IMCODES_TASK DISPATCH T4 executor=' + EXEC + ' title="T4" -->');
    expect(pair('T4')?.title).toBe('Untitled task');
    await say(BRAIN, '<!-- IMCODES_TASK DISPATCH T5 executor=' + EXEC + ' title="Brain: fix login" -->');
    expect(pair('T5')?.title).toBe('Untitled task');
    await say(BRAIN, '<!-- IMCODES_TASK DISPATCH T6 executor=' + EXEC + ' title="Fix login" -->');
    expect(pair('T6')?.title).toBe('Fix login');
  });

  it('creates implicit send_message pairs with a placeholder and batches requests', async () => {
    setBrainLocale('zh-CN');
    clearSendIdempotencyCacheForTests();
    const dispatchMessage = vi.fn().mockResolvedValue('sent');
    const listSessions = () => [session(BRAIN, 'brain'), session(EXEC, 'w2'), session(AUD, 'w3')];
    const brainCaller = { userId: 'u', sessionName: BRAIN, projectName: PROJECT, projectRoot: `/tmp/${PROJECT}` };
    const created = await dispatchSendMessage(brainCaller, {
      target: EXEC, message: 'Please fix login.', task: { taskId: 'T9', objective: 'fix login' },
    } as never, { listSessions, dispatchMessage });
    expect(created).toMatchObject({ status: 'accepted', taskId: 'T9', taskTitle: '未命名任务' });
    expect(pair('T9')?.title).toBe('未命名任务');
    expect(sent.filter((entry) => entry.target === BRAIN)).toHaveLength(1);

    const withExplicitTitle = await dispatchSendMessage(brainCaller, {
      target: AUD, message: 'Please review.', task: { taskId: 'T10', objective: 'review PR', title: 'Human title' },
    } as never, { listSessions, dispatchMessage });
    expect(withExplicitTitle).toMatchObject({ status: 'accepted', taskId: 'T10', taskTitle: 'Human title' });
    expect(pair('T10')?.title).toBe('Human title');
  });

  it('coalesces multiple missing titles in one turn and does not contact an offline Brain', async () => {
    setBrainLocale('en');
    await say(BRAIN, [
      '<!-- IMCODES_TASK QUEUE T13 -->', 'First task.', '<!-- IMCODES_TASK_END T13 -->',
      '<!-- IMCODES_TASK QUEUE T14 -->', 'Second task.', '<!-- IMCODES_TASK_END T14 -->',
    ].join('\n'));
    await service.waitForIdle();
    expect(sent.filter((entry) => entry.target === BRAIN)).toHaveLength(1);
    expect(sent[0]?.text).toContain('T13');
    expect(sent[0]?.text).toContain('T14');

    sent = [];
    upsertSession(session(BRAIN, 'brain', { state: 'stopped' }));
    await say(BRAIN, '<!-- IMCODES_TASK QUEUE T15 -->\nOffline task.\n<!-- IMCODES_TASK_END T15 -->');
    await service.waitForIdle();
    expect(sent).toHaveLength(0);
  });

  it('lets Brain set a queued title with a marker without changing the brief', async () => {
    setBrainLocale('en');
    await say(BRAIN, '<!-- IMCODES_TASK QUEUE T11 -->\nDo the work.\n<!-- IMCODES_TASK_END T11 -->');
    await say(BRAIN, '<!-- IMCODES_TASK DISPATCH T11 title="Do the work" -->');
    expect(pair('T11')?.title).toBe('Do the work');
    expect(pair('T11')?.brief).toContain('Do the work.');
  });

});
