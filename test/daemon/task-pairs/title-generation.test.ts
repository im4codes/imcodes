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
import { removeSession, upsertSession } from '../../../src/store/session-store.js';
import { timelineEmitter } from '../../../src/daemon/timeline-emitter.js';
import { TaskPairStore, setTaskPairStoreForTests, getTaskPairStore } from '../../../src/daemon/task-pairs/store.js';
import { setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import { TaskPairService, taskPairService } from '../../../src/daemon/task-pairs/service.js';
import { setTaskPairTitleGeneratorForTests } from '../../../src/daemon/task-pairs/title-generator.js';
import { dispatchSendMessage, clearSendIdempotencyCacheForTests } from '../../../src/daemon/send-tool.js';
import { normalizeSessionSupervisionSnapshot } from '../../../shared/supervision-config.js';
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
    transportConfig: locale ? { supervision: normalizeSessionSupervisionSnapshot({ uiLocale: locale }) } : undefined,
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
    setTaskPairTitleGeneratorForTests(undefined);
    setTaskPairDeliveryDepsForTests(undefined);
    setTaskPairStoreForTests(undefined);
    for (const name of [BRAIN, EXEC, AUD]) removeSession(name);
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  });

  it('generates a localized title for a titleless QUEUE pair without blocking marker handling', async () => {
    setBrainLocale('zh-CN');
    let resolveGen!: (value: string) => void;
    const generated = new Promise<string>((resolve) => { resolveGen = resolve; });
    const gen = vi.fn().mockReturnValue(generated);
    setTaskPairTitleGeneratorForTests(gen);
    await say(BRAIN, [
      'Queueing.',
      '<!-- IMCODES_TASK QUEUE T1 -->',
      'Fix the login bug for SSO users.',
      '<!-- IMCODES_TASK_END T1 -->',
    ].join('\n'));
    // The marker transition (pair created, queued) completed synchronously;
    // generation is still in flight and must not have blocked it.
    expect(pair('T1')?.status).toBe('queued');
    expect(pair('T1')?.title).toBeUndefined();
    expect(gen).toHaveBeenCalledWith(expect.stringContaining('Fix the login bug'), 'zh-CN', expect.anything());
    resolveGen('修复登录问题');
    await service.waitForIdle();
    expect(pair('T1')?.title).toBe('修复登录问题');
  });

  it('never generates over an explicit title', async () => {
    setBrainLocale('zh-CN');
    const gen = vi.fn();
    setTaskPairTitleGeneratorForTests(gen);
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T2 executor=${EXEC} auditor=${AUD} title="Fix login" -->`);
    await service.waitForIdle();
    expect(pair('T2')?.title).toBe('Fix login');
    expect(gen).not.toHaveBeenCalled();
  });

  it('does not generate when the project has no configured UI locale (headless/legacy caller)', async () => {
    setBrainLocale(undefined);
    const gen = vi.fn();
    setTaskPairTitleGeneratorForTests(gen);
    await say(BRAIN, [
      'Queueing.',
      '<!-- IMCODES_TASK QUEUE T3 -->',
      'Some brief describing real work.',
      '<!-- IMCODES_TASK_END T3 -->',
    ].join('\n'));
    await service.waitForIdle();
    expect(gen).not.toHaveBeenCalled();
    expect(pair('T3')?.title).toBeUndefined();
    expect(pair('T3')?.brief).toContain('Some brief describing real work');
  });

  it('keeps the pair titleless when generation fails, falling back to the mechanical (brief) state', async () => {
    setBrainLocale('en');
    setTaskPairTitleGeneratorForTests(async () => undefined);
    await say(BRAIN, [
      'Queueing.',
      '<!-- IMCODES_TASK QUEUE T4 -->',
      'Some brief describing real work.',
      '<!-- IMCODES_TASK_END T4 -->',
    ].join('\n'));
    await service.waitForIdle();
    expect(pair('T4')?.title).toBeUndefined();
    expect(pair('T4')?.status).toBe('queued');
  });

  it('never lets a slow generation call clobber a title a later marker set', async () => {
    setBrainLocale('zh-CN');
    let resolveGen!: (value: string) => void;
    const generated = new Promise<string>((resolve) => { resolveGen = resolve; });
    setTaskPairTitleGeneratorForTests(() => generated);
    await say(BRAIN, [
      'Queueing.',
      '<!-- IMCODES_TASK QUEUE T5 -->',
      'Some brief describing real work.',
      '<!-- IMCODES_TASK_END T5 -->',
    ].join('\n'));
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T5 executor=${EXEC} title="Explicit override" -->`);
    expect(pair('T5')?.title).toBe('Explicit override');
    resolveGen('generated-too-late');
    await service.waitForIdle();
    expect(pair('T5')?.title).toBe('Explicit override');
  });

  it('emits a task-pair timeline event carrying the newly generated title', async () => {
    setBrainLocale('zh-CN');
    setTaskPairTitleGeneratorForTests(async () => '修复登录问题');
    const seen: Array<Record<string, unknown>> = [];
    const off = timelineEmitter.on((event) => {
      if (event.type === TASK_PAIR_TIMELINE_EVENT) seen.push(event.payload as Record<string, unknown>);
    });
    await say(BRAIN, [
      'Queueing.',
      '<!-- IMCODES_TASK QUEUE T6 -->',
      'Fix the login bug.',
      '<!-- IMCODES_TASK_END T6 -->',
    ].join('\n'));
    await service.waitForIdle();
    off();
    expect(seen.some((payload) => payload.taskId === 'T6' && payload.title === '修复登录问题')).toBe(true);
  });

  it('back-fills a generic legacy-import placeholder title once, from its own text', async () => {
    setBrainLocale('en');
    getTaskPairStore().savePair(PROJECT, {
      taskId: 'T7', brain: BRAIN, executor: EXEC, auditor: AUD, status: 'working',
      title: TASK_PAIR_GENERIC_TITLE_PLACEHOLDERS[0], flags: [], flagSides: {}, round: 0, blocking: [],
      previousAuditors: [], capCounts: {}, capRound: 0, createdAt: 1, updatedAt: 1,
    } as never);
    const gen = vi.fn(async (brief: string) => {
      expect(brief).toBe(TASK_PAIR_GENERIC_TITLE_PLACEHOLDERS[0]);
      return 'Delegated task';
    });
    setTaskPairTitleGeneratorForTests(gen);
    await say(BRAIN, 'Just a plain status update, no marker at all.');
    await service.waitForIdle();
    expect(pair('T7')?.title).toBe('Delegated task');
    expect(gen).toHaveBeenCalledTimes(1);

    // A second turn on the same project does not re-run the back-fill sweep.
    await say(BRAIN, 'Another plain status update.');
    await service.waitForIdle();
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it('leaves an untitled pair with no brief alone (nothing to generate from)', async () => {
    setBrainLocale('en');
    const gen = vi.fn();
    setTaskPairTitleGeneratorForTests(gen);
    await say(BRAIN, `<!-- IMCODES_TASK DISPATCH T8 executor=${EXEC} auditor=${AUD} -->`);
    await service.waitForIdle();
    expect(pair('T8')?.title).toBeUndefined();
    expect(gen).not.toHaveBeenCalled();
  });

  it('generates a localized title from a send_message wrapper-pair objective, and skips it when an explicit title is given', async () => {
    setBrainLocale('zh-CN');
    clearSendIdempotencyCacheForTests();
    const gen = vi.fn(async (brief: string) => {
      expect(brief).toBe('fix login');
      return '修复登录';
    });
    setTaskPairTitleGeneratorForTests(gen);
    const dispatchMessage = vi.fn().mockResolvedValue('sent');
    const listSessions = () => [session(BRAIN, 'brain'), session(EXEC, 'w2'), session(AUD, 'w3')];
    const brainCaller = { userId: 'u', sessionName: BRAIN, projectName: PROJECT, projectRoot: `/tmp/${PROJECT}` };
    const created = await dispatchSendMessage(brainCaller, {
      target: EXEC, message: 'Please fix login.', task: { taskId: 'T9', objective: 'fix login' },
    } as never, { listSessions, dispatchMessage });
    expect(created).toMatchObject({ status: 'accepted', taskId: 'T9', taskTitle: 'fix login' });
    expect(pair('T9')?.title).toBe('fix login');
    await taskPairService.waitForIdle();
    expect(pair('T9')?.title).toBe('修复登录');

    const explicitGen = vi.fn();
    setTaskPairTitleGeneratorForTests(explicitGen);
    const withExplicitTitle = await dispatchSendMessage(brainCaller, {
      target: AUD, message: 'Please review.', task: { taskId: 'T10', objective: 'review PR', title: 'Human title' },
    } as never, { listSessions, dispatchMessage });
    expect(withExplicitTitle).toMatchObject({ status: 'accepted', taskId: 'T10', taskTitle: 'Human title' });
    await taskPairService.waitForIdle();
    expect(pair('T10')?.title).toBe('Human title');
    expect(explicitGen).not.toHaveBeenCalled();
  });
});
