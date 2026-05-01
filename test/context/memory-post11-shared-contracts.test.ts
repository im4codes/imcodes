import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEND_ORIGIN,
  SEND_ORIGINS,
  TRUSTED_PREF_WRITE_ORIGINS,
  isSendOrigin,
  isTrustedPreferenceWriteOrigin,
  normalizeSendOrigin,
} from '../../shared/send-origin.js';
import {
  SKILL_REVIEW_TRIGGERS,
  isSkillReviewTrigger,
} from '../../shared/skill-review-triggers.js';
import {
  BUILTIN_SKILL_MANIFEST_VERSION,
  EMPTY_BUILTIN_SKILL_MANIFEST,
  validateBuiltinSkillManifest,
} from '../../shared/builtin-skill-manifest.js';
import { MEMORY_SOFT_FAIL_PATH_COUNTERS, isMemoryCounter } from '../../shared/memory-counters.js';
import { MemoryTelemetryBuffer, sanitizeMemoryTelemetryLabels } from '../../shared/memory-telemetry.js';

describe('post-1.1 shared constants inventory', () => {
  it('defines session.send origin and trusted @pref write boundary', () => {
    expect(SEND_ORIGINS).toEqual([
      'user_keyboard',
      'user_voice',
      'user_resend',
      'agent_output',
      'tool_output',
      'system_inject',
    ]);
    expect(DEFAULT_SEND_ORIGIN).toBe('system_inject');
    expect(normalizeSendOrigin(undefined)).toBe('system_inject');
    expect(isSendOrigin('user_keyboard')).toBe(true);
    expect(isTrustedPreferenceWriteOrigin('user_keyboard')).toBe(true);
    expect(isTrustedPreferenceWriteOrigin('agent_output')).toBe(false);
    expect(isTrustedPreferenceWriteOrigin(DEFAULT_SEND_ORIGIN)).toBe(false);
    expect(TRUSTED_PREF_WRITE_ORIGINS).toEqual(['user_keyboard', 'user_voice', 'user_resend']);
  });

  it('defines closed skill review triggers for background-only skill auto-creation', () => {
    expect(SKILL_REVIEW_TRIGGERS).toEqual(['tool_iteration_count', 'manual_review']);
    expect(isSkillReviewTrigger('tool_iteration_count')).toBe(true);
    expect(isSkillReviewTrigger('send_path')).toBe(false);
  });

  it('defines and packages an empty built-in skill manifest as the lowest-precedence fallback', () => {
    expect(BUILTIN_SKILL_MANIFEST_VERSION).toBe(1);
    expect(validateBuiltinSkillManifest(EMPTY_BUILTIN_SKILL_MANIFEST)).toEqual({ version: 1, skills: [] });
    expect(() => validateBuiltinSkillManifest({ version: 1, skills: [{ name: '', category: 'x', path: 'x.md' }] })).toThrow(/skill name/);

    const copyScript = readFileSync('scripts/copy-worker-bootstraps.mjs', 'utf8');
    expect(copyScript).toContain('dist/builtin-skills');
    expect(copyScript).toContain('manifest.json');
    expect(copyScript).toContain('skills: []');
  });
});

describe('post-1.1 bounded memory telemetry', () => {
  it('rejects high-cardinality/free-form telemetry labels', () => {
    expect(sanitizeMemoryTelemetryLabels({
      feature: 'mem.feature.quick_search',
      origin: 'chat_compacted',
      send_origin: 'user_keyboard',
      fingerprint_kind: 'summary',
      observation_class: 'decision',
      skill_review_trigger: 'manual_review',
      outcome: 'disabled',
      reason: 'feature_off',
    })).toMatchObject({ feature: 'mem.feature.quick_search', outcome: 'disabled' });

    expect(() => sanitizeMemoryTelemetryLabels({ session_id: 's1' } as never)).toThrow(/Unsupported/);
    expect(() => sanitizeMemoryTelemetryLabels({ reason: 'github.com/acme/repo' })).toThrow(/Invalid/);
    expect(() => sanitizeMemoryTelemetryLabels({ feature: 'mem.feature.unknown' })).toThrow(/Invalid/);
  });

  it('drops predictably on overflow and swallows sink failures without throwing', async () => {
    const dropped: string[] = [];
    const overflowBuffer = new MemoryTelemetryBuffer({
      maxSize: 1,
      onDrop: (event) => dropped.push(event.counter),
      now: () => 123,
    });

    expect(overflowBuffer.enqueue('mem.search.disabled', { feature: 'mem.feature.quick_search', outcome: 'disabled' })).toBe(true);
    expect(overflowBuffer.enqueue('mem.telemetry.buffer_overflow', { outcome: 'dropped', reason: 'buffer_full' })).toBe(false);
    expect(dropped).toEqual(['mem.telemetry.buffer_overflow']);
    expect(overflowBuffer.size).toBe(1);

    const failingSinkBuffer = new MemoryTelemetryBuffer({
      maxSize: 2,
      sink: { record: async () => { throw new Error('sink down'); } },
      now: () => 456,
    });
    expect(failingSinkBuffer.enqueue('mem.search.disabled', { feature: 'mem.feature.quick_search', outcome: 'disabled' })).toBe(true);
    await failingSinkBuffer.flush();
    expect(failingSinkBuffer.size).toBe(0);
  });

  it('bounds telemetry sink timeouts and inventories soft-fail path counters', async () => {
    const hangingSinkBuffer = new MemoryTelemetryBuffer({
      maxSize: 2,
      sinkTimeoutMs: 5,
      sink: { record: () => new Promise<void>(() => {}) },
      now: () => 789,
    });
    expect(hangingSinkBuffer.enqueue('mem.search.disabled', { feature: 'mem.feature.quick_search', outcome: 'disabled' })).toBe(true);
    await expect(hangingSinkBuffer.flush()).resolves.toBeUndefined();
    expect(hangingSinkBuffer.size).toBe(0);

    expect(Object.keys(MEMORY_SOFT_FAIL_PATH_COUNTERS).sort()).toEqual([
      'citation',
      'cite_count',
      'classification',
      'materialization',
      'md_ingest',
      'observations',
      'preferences',
      'search',
      'skill_review',
      'skills',
      'startup_memory',
    ]);
    for (const counter of Object.values(MEMORY_SOFT_FAIL_PATH_COUNTERS)) {
      expect(isMemoryCounter(counter)).toBe(true);
    }
  });
});
