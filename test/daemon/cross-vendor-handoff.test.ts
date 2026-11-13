import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CROSS_VENDOR_HANDOFF_DEFAULTS,
  normalizeCrossVendorHandoffConfig,
  isCrossVendorHandoffLaunchCurrent,
  beginCrossVendorHandoffState,
} from '../../shared/cross-vendor-handoff.js';
import { buildCrossVendorHandoffPack, resolveCrossVendorHandoffPack, shouldCreateCrossVendorHandoff, sourceConversationKey } from '../../src/daemon/cross-vendor-handoff.js';
import { timelineStore } from '../../src/daemon/timeline-store.js';
import * as tokenizer from '../../src/context/tokenizer.js';

vi.mock('../../src/context/tokenizer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/context/tokenizer.js')>();
  return {
    ...actual,
    countTokensAsync: vi.fn((...args: Parameters<typeof actual.countTokensAsync>) => actual.countTokensAsync(...args)),
  };
});
import { setTaskPairStoreForTests, TASK_PAIRS_DB_PATH_ENV, TaskPairStore } from '../../src/daemon/task-pairs/store.js';
import { DAEMON_USER_NOTICE_CODE } from '../../shared/daemon-user-notices.js';
import type { TimelineEvent } from '../../src/daemon/timeline-event.js';

const event = (type: TimelineEvent['type'], payload: Record<string, unknown>, seq: number, ts: number): TimelineEvent => ({
  eventId: `evt-${seq}`,
  sessionId: 'handoff-test',
  ts,
  seq,
  epoch: 7,
  source: 'daemon',
  confidence: 'high',
  type,
  payload,
});

const record = (agentType: string) => ({
  name: 'handoff-test', agentType, runtimeType: agentType.endsWith('-sdk') ? 'transport' : 'process',
  projectName: 'project', projectDir: '/repo', role: 'brain', state: 'idle',
  createdAt: 1, updatedAt: 1, restarts: 0, restartTimestamps: [],
} as never);

afterEach(() => vi.restoreAllMocks());

describe('cross-vendor handoff contract', () => {
  it('normalizes bounded defaults and hard cap', () => {
    expect(normalizeCrossVendorHandoffConfig()).toEqual({
      enabled: true,
      maxTokens: CROSS_VENDOR_HANDOFF_DEFAULTS.maxTokens,
      recentTurns: CROSS_VENDOR_HANDOFF_DEFAULTS.recentTurns,
      timeoutMs: CROSS_VENDOR_HANDOFF_DEFAULTS.timeoutMs,
      providerWaitMs: CROSS_VENDOR_HANDOFF_DEFAULTS.providerWaitMs,
      includeToolPreviews: false,
    });
    expect(normalizeCrossVendorHandoffConfig({ maxTokens: 99_999, recentTurns: 0, timeoutMs: 1 })).toMatchObject({
      maxTokens: CROSS_VENDOR_HANDOFF_DEFAULTS.hardMaxTokens,
      recentTurns: 1,
      timeoutMs: 250,
    });
    expect(normalizeCrossVendorHandoffConfig().maxTokens).toBe(50_000);
    expect(normalizeCrossVendorHandoffConfig().recentTurns).toBe(100);
    expect(normalizeCrossVendorHandoffConfig({ maxTokens: 50_001, recentTurns: 999 })).toMatchObject({ maxTokens: 50_000, recentTurns: 100 });
  });

  it('triggers only for a non-fresh family or runtime-kind switch unless forced for /handoff', () => {
    expect(shouldCreateCrossVendorHandoff({ agentType: 'claude-code-sdk', runtimeType: 'transport' }, 'codex-sdk', 'transport', false)).toBe(true);
    expect(shouldCreateCrossVendorHandoff({ agentType: 'claude-code-sdk', runtimeType: 'transport' }, 'claude-code-sdk', 'transport', false)).toBe(false);
    expect(shouldCreateCrossVendorHandoff({ agentType: 'claude-code', runtimeType: 'process' }, 'claude-code-sdk', 'transport', false)).toBe(true);
    expect(shouldCreateCrossVendorHandoff({ agentType: 'claude-code-sdk', runtimeType: 'transport' }, 'codex-sdk', 'transport', true)).toBe(false);
    expect(shouldCreateCrossVendorHandoff({ agentType: 'claude-code-sdk', runtimeType: 'transport' }, 'claude-code-sdk', 'transport', true, true)).toBe(true);
    expect(shouldCreateCrossVendorHandoff({ agentType: 'claude-code', runtimeType: 'process' }, 'claude-code', 'process', true, true)).toBe(true);
  });

  it('covers SDK, process/tmux, Qoder, and runtime-kind matrix without conflating native threads', () => {
    const cases: Array<[string, string, 'process' | 'transport', boolean]> = [
      ['claude-code-sdk', 'codex-sdk', 'transport', true],
      ['codex-sdk', 'claude-code-sdk', 'transport', true],
      ['claude-code', 'codex', 'process', true],
      ['codex', 'claude-code', 'process', true],
      ['claude-code-sdk', 'qoder-sdk', 'transport', true],
      ['claude-code', 'claude-code-sdk', 'transport', true],
    ];
    for (const [source, target, runtime, expected] of cases) {
      expect(shouldCreateCrossVendorHandoff({ agentType: source, runtimeType: source.endsWith('-sdk') ? 'transport' : 'process' }, target, runtime, false)).toBe(expected);
    }
    expect(sourceConversationKey({ agentType: 'claude-code-sdk', ccSessionId: 'cc-native' })).toBe('cc-native');
    expect(sourceConversationKey({ agentType: 'codex-sdk', codexSessionId: 'codex-native' })).toBe('codex-native');
    expect(sourceConversationKey({ agentType: 'qoder-sdk', providerSessionId: 'qoder-native' })).toBe('qoder-native');
  });

  it('builds a redacted, hard-bounded text-only pack even with legacy tool-preview settings', async () => {
    vi.spyOn(timelineStore, 'readCompletedTextTail').mockResolvedValue([
      event('user.message', { text: 'Bearer abcdefghijklmnopqrst secret request' }, 1, 10),
      event('assistant.text', { text: 'A'.repeat(20_000), streaming: false }, 2, 11),
      event('tool.call', { tool: 'shell', status: 'complete', output: 'password=hunter2' }, 3, 12),
    ]);
    const pack = await buildCrossVendorHandoffPack(record('claude-code-sdk'), { epoch: 7, seq: 3, ts: 20 }, 'codex-sdk', 'transport', { maxTokens: 40, includeToolPreviews: true });
    expect(pack).toBeDefined();
    expect(pack!.tokenCount).toBeLessThanOrEqual(40);
    expect(pack!.text).toContain('Non-authoritative prior context');
    expect(pack!.text).not.toContain('hunter2');
    expect(pack!.text).not.toContain('abcdefghijklmnopqrst');
    expect(pack!.text).not.toContain('password=');
  });

  it('reads the inclusive frozen text tail even on a switch back', async () => {
    const read = vi.spyOn(timelineStore, 'readCompletedTextTail').mockResolvedValue([
      event('user.message', { text: 'delta' }, 9, 100),
    ]);
    await buildCrossVendorHandoffPack(record('codex-sdk'), { epoch: 7, seq: 20, ts: 200 }, 'claude-code-sdk', 'transport', undefined, { epoch: 7, seq: 8, ts: 99 });
    expect(read).toHaveBeenCalledWith('handoff-test', 100, { visibleOnly: true, through: { epoch: 7, seq: 20, ts: 200 } });
  });

  it('disables generation explicitly and preserves the one-shot configuration bounds', async () => {
    const read = vi.spyOn(timelineStore, 'readCompletedTextTail');
    await expect(buildCrossVendorHandoffPack(record('qoder-sdk'), { epoch: 1, seq: 1, ts: 1 }, 'claude-code-sdk', 'transport', { enabled: false })).resolves.toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(normalizeCrossVendorHandoffConfig({ maxTokens: CROSS_VENDOR_HANDOFF_DEFAULTS.hardMaxTokens + 1 }).maxTokens).toBe(CROSS_VENDOR_HANDOFF_DEFAULTS.hardMaxTokens);
  });
  it('degrades to no handoff when the projection is busy or unavailable', async () => {
    vi.spyOn(timelineStore, 'readCompletedTextTail').mockRejectedValue(new Error('projection busy'));
    await expect(buildCrossVendorHandoffPack(record('claude-code-sdk'), { epoch: 1, seq: 1, ts: 1 }, 'codex-sdk', 'transport')).resolves.toBeUndefined();
  });

  it('rejects stale callbacks from an older launch generation', () => {
    expect(isCrossVendorHandoffLaunchCurrent({ expectedGeneration: 1, currentGeneration: 2, currentAgentType: 'claude-code-sdk', targetAgentType: 'claude-code-sdk' })).toBe(false);
    expect(isCrossVendorHandoffLaunchCurrent({ expectedGeneration: 2, currentGeneration: 2, currentAgentType: 'claude-code-sdk', targetAgentType: 'claude-code-sdk' })).toBe(true);
    expect(isCrossVendorHandoffLaunchCurrent({ expectedGeneration: 2, currentGeneration: 2, currentAgentType: 'codex-sdk', targetAgentType: 'claude-code-sdk' })).toBe(false);
  });

  it('replaces a pending pack when a consecutive switch starts', () => {
    const prior = {
      pending: { text: 'pack-A', sourceAgentType: 'claude-code-sdk', sourceRuntimeType: 'transport' as const, cutoff: { epoch: 1, seq: 2, ts: 2 }, createdAt: 1, tokenCount: 1 },
      cutoffs: { 'codex-sdk': { epoch: 1, seq: 2, ts: 2 } },
    };
    const next = beginCrossVendorHandoffState(prior, normalizeCrossVendorHandoffConfig(), 'codex-sdk', { epoch: 1, seq: 3, ts: 3 });
    expect(next.pending).toBeUndefined();
    expect(next.cutoffs?.['codex-sdk']).toEqual({ epoch: 1, seq: 3, ts: 3 });
  });

  it('times out a stuck projection without delaying the caller', async () => {
    const started = Date.now();
    const result = await resolveCrossVendorHandoffPack(new Promise(() => undefined), 5);
    expect(result).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(250);
  });

});


describe('reported lost provider-switch context counterexamples', () => {
  it.each([undefined, 3000])('upgrades the old ten-message setting and preserves the newest messages first (budget=%s)', async (maxTokens) => {
    expect(normalizeCrossVendorHandoffConfig({ recentTurns: 10 }).recentTurns).toBe(10);
    const rows = Array.from({ length: 30 }, (_, i) => event(i % 2 ? 'assistant.text' : 'user.message', { text: `消息${i}开始：${'这是需要保留的历史正文。'.repeat(120)}` }, i + 1, i + 1));
    vi.spyOn(timelineStore, 'readCompletedTextTail').mockResolvedValue(rows);
    const pack = await buildCrossVendorHandoffPack(record('codex-sdk'), { epoch: 7, seq: 30, ts: 30 }, 'agy-sdk', 'transport', { maxTokens });
    expect(pack).toBeDefined();
    expect(pack!.text).toContain('消息29开始');
    if (maxTokens === undefined) expect(pack!.text).toContain('消息0开始');
    else expect(pack!.text).not.toContain('消息0开始');
    expect(pack!.tokenCount).toBeLessThanOrEqual(maxTokens ?? CROSS_VENDOR_HANDOFF_DEFAULTS.maxTokens);
  });
  it('includes the user message that is itself the frozen cutoff', async () => {
    const rows = [event('user.message', { text: 'REMEMBER_SWITCH_GOAL_7B' }, 1, 100)];
    vi.spyOn(timelineStore, 'readCompletedTextTail').mockImplementation(async (_name, limit, options) => rows.filter((e) => (e.type === 'user.message' || (e.type === 'assistant.text' && e.payload.streaming !== true)) && (!options?.through || e.seq <= options.through.seq)).slice(-(limit ?? 50)));
    const pack = await buildCrossVendorHandoffPack(record('codex-sdk'), { epoch: 7, seq: 1, ts: 100 }, 'agy-sdk', 'transport');
    expect(pack?.text).toContain('REMEMBER_SWITCH_GOAL_7B');
  });
  it('does not let tool events crowd completed conversation out of the handoff', async () => {
    const rows = [event('user.message', { text: 'CURRENT_GOAL_8C' }, 1, 1), event('assistant.text', { text: 'CONFIRMED_DECISION_8C', streaming: false }, 2, 2),
      ...Array.from({ length: 200 }, (_, i) => event('tool.result', { tool: 'shell', status: 'complete' }, i + 3, i + 3))];
    vi.spyOn(timelineStore, 'readCompletedTextTail').mockImplementation(async (_name, limit, options) => rows.filter((e) => (e.type === 'user.message' || (e.type === 'assistant.text' && e.payload.streaming !== true)) && (!options?.through || e.seq <= options.through.seq)).slice(-(limit ?? 50)));
    const pack = await buildCrossVendorHandoffPack(record('codex-sdk'), { epoch: 7, seq: 202, ts: 202 }, 'agy-sdk', 'transport');
    expect(pack?.text).toContain('CURRENT_GOAL_8C');
    expect(pack?.text).toContain('CONFIRMED_DECISION_8C');
  });
  it('keeps the newest completed messages when the handoff token budget is tight', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => event(
      i % 2 ? 'assistant.text' : 'user.message',
      { text: `${i === 99 ? 'NEWEST_GOAL_9D' : `OLD_GOAL_${i}`} ${'context '.repeat(300)}` },
      i + 1,
      i + 1,
    ));
    vi.spyOn(timelineStore, 'readCompletedTextTail').mockResolvedValue(rows);
    const pack = await buildCrossVendorHandoffPack(
      record('codex-sdk'),
      { epoch: 7, seq: 100, ts: 100 },
      'agy-sdk',
      'transport',
      { recentTurns: 100, maxTokens: 120 },
    );
    expect(pack).toBeDefined();
    expect(pack!.text).toContain('NEWEST_GOAL_9D');
    expect(pack!.text).not.toContain('OLD_GOAL_0');
    expect(pack!.tokenCount).toBeLessThanOrEqual(120);
  });
  it('returns undefined when completed timeline has no non-control turns (prevents empty/loop handoffs)', async () => {
    vi.spyOn(timelineStore, 'readCompletedTextTail').mockResolvedValueOnce([]);
    const emptyPack = await buildCrossVendorHandoffPack(record('claude-code-sdk'), { epoch: 1, seq: 1, ts: 1 }, 'claude-code-sdk', 'transport');
    expect(emptyPack).toBeUndefined();

    vi.spyOn(timelineStore, 'readCompletedTextTail').mockResolvedValueOnce([
      event('user.message', { text: '/clear' }, 1, 1),
      event('user.message', { text: ' /handoff ' }, 2, 2),
      event('user.message', { text: '/compact' }, 3, 3),
    ]);
    const controlOnlyPack = await buildCrossVendorHandoffPack(record('claude-code-sdk'), { epoch: 1, seq: 3, ts: 3 }, 'claude-code-sdk', 'transport');
    expect(controlOnlyPack).toBeUndefined();
  });
  it('strips bare session control commands while preserving real turns on consecutive handoffs', async () => {
    vi.spyOn(timelineStore, 'readCompletedTextTail').mockResolvedValue([
      event('user.message', { text: 'Fix login retry backoff' }, 1, 1),
      event('assistant.text', { text: 'Updated backoff in auth.ts', streaming: false }, 2, 2),
      event('user.message', { text: '/handoff' }, 3, 3),
    ]);
    const pack = await buildCrossVendorHandoffPack(record('claude-code-sdk'), { epoch: 1, seq: 3, ts: 3 }, 'claude-code-sdk', 'transport');
    expect(pack).toBeDefined();
    expect(pack!.text).toContain('Fix login retry backoff');
    expect(pack!.text).toContain('Updated backoff in auth.ts');
    expect(pack!.text).not.toContain('/handoff');
  });

  it('bounds tokenizer worker IPC to <= 2 calls on 100-turn CJK overload and preserves newest turns within budget', async () => {
    const countMock = vi.mocked(tokenizer.countTokensAsync);
    countMock.mockClear();
    const rows = Array.from({ length: 100 }, (_, i) => event(
      i % 2 ? 'assistant.text' : 'user.message',
      { text: `第${i}轮：${'上下文交接正文测试内容。'.repeat(100)}` },
      i + 1,
      i + 1,
    ));
    vi.spyOn(timelineStore, 'readCompletedTextTail').mockResolvedValue(rows);
    const started = performance.now();
    const pack = await buildCrossVendorHandoffPack(
      record('agy-sdk'),
      { epoch: 7, seq: 100, ts: 100 },
      'agy-sdk',
      'transport',
      { maxTokens: 16_000 },
    );
    const elapsedMs = performance.now() - started;
    expect(pack).toBeDefined();
    expect(pack!.tokenCount).toBeLessThanOrEqual(16_000);
    expect(pack!.text).toContain('第99轮');
    expect(countMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(countMock.mock.calls.length).toBeLessThanOrEqual(2);
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('includes concise redacted active/recent task-pair state and excludes daemon reset notices', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-handoff-pairs-'));
    try {
      vi.stubEnv(TASK_PAIRS_DB_PATH_ENV, join(dir, 'task-pairs.sqlite'));
      const store = new TaskPairStore(join(dir, 'task-pairs.sqlite'));
      setTaskPairStoreForTests(store);
      store.savePair('project', {
        v: 1,
        engine: 'pairs',
        project: 'project',
        taskId: 'tsk_active_handoff',
        title: 'Handoff token=ghp_1234567890abcdefghij fix',
        brief: 'Long brief omitted from summary',
        brain: 'handoff-test',
        executor: 'deck_sub_exec',
        auditor: 'deck_sub_aud',
        workspace: { kind: 'dir', path: '/repo' },
        status: 'in_audit',
        round: 2,
        reworkCount: 0,
        revision: '1',
        createdAt: 100,
        updatedAt: 200,
      });
      vi.spyOn(timelineStore, 'readCompletedTextTail').mockResolvedValue([
        event('assistant.text', {
          text: 'Started a fresh conversation',
          noticeCode: DAEMON_USER_NOTICE_CODE.CONVERSATION_STARTED,
          streaming: false,
        }, 1, 10),
        event('user.message', { text: 'Check pair progress' }, 2, 20),
        event('assistant.text', { text: 'Verified test suite', streaming: false }, 3, 30),
      ]);
      const pack = await buildCrossVendorHandoffPack(record('agy-sdk'), { epoch: 1, seq: 3, ts: 30 }, 'agy-sdk', 'transport');
      expect(pack).toBeDefined();
      expect(pack!.text).toContain('Work state pointers:');
      expect(pack!.text).toContain('tsk_active_handoff [in_audit]');
      expect(pack!.text).not.toContain('ghp_1234567890abcdefghij');
      expect(pack!.text).not.toContain('Long brief omitted from summary');
      expect(pack!.text).not.toContain('Started a fresh conversation');
      expect(pack!.text).toContain('Check pair progress');
    } finally {
      setTaskPairStoreForTests(undefined);
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
