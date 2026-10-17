import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CROSS_VENDOR_HANDOFF_DEFAULTS,
  normalizeCrossVendorHandoffConfig,
  isCrossVendorHandoffLaunchCurrent,
  beginCrossVendorHandoffState,
} from '../../shared/cross-vendor-handoff.js';
import { buildCrossVendorHandoffPack, resolveCrossVendorHandoffPack, shouldCreateCrossVendorHandoff, sourceConversationKey } from '../../src/daemon/cross-vendor-handoff.js';
import { timelineStore } from '../../src/daemon/timeline-store.js';
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
      recentTurns: 30,
      timeoutMs: 250,
    });
  });

  it('triggers only for a non-fresh family or runtime-kind switch', () => {
    expect(shouldCreateCrossVendorHandoff({ agentType: 'claude-code-sdk', runtimeType: 'transport' }, 'codex-sdk', 'transport', false)).toBe(true);
    expect(shouldCreateCrossVendorHandoff({ agentType: 'claude-code-sdk', runtimeType: 'transport' }, 'claude-code-sdk', 'transport', false)).toBe(false);
    expect(shouldCreateCrossVendorHandoff({ agentType: 'claude-code', runtimeType: 'process' }, 'claude-code-sdk', 'transport', false)).toBe(true);
    expect(shouldCreateCrossVendorHandoff({ agentType: 'claude-code-sdk', runtimeType: 'transport' }, 'codex-sdk', 'transport', true)).toBe(false);
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
    expect(read).toHaveBeenCalledWith('handoff-test', 30, { visibleOnly: true, through: { epoch: 7, seq: 20, ts: 200 } });
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
  it.each([undefined, 3000])('upgrades the old ten-message setting and preserves all thirty messages (budget=%s)', async (maxTokens) => {
    expect(normalizeCrossVendorHandoffConfig({ recentTurns: 10 }).recentTurns).toBe(30);
    const rows = Array.from({ length: 30 }, (_, i) => event(i % 2 ? 'assistant.text' : 'user.message', { text: `消息${i}开始：${'这是需要保留的历史正文。'.repeat(120)}` }, i + 1, i + 1));
    vi.spyOn(timelineStore, 'readCompletedTextTail').mockResolvedValue(rows);
    const pack = await buildCrossVendorHandoffPack(record('codex-sdk'), { epoch: 7, seq: 30, ts: 30 }, 'agy-sdk', 'transport', { maxTokens });
    expect(pack).toBeDefined();
    for (let i = 0; i < 30; i++) expect(pack!.text).toContain(`消息${i}开始`);
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
});
