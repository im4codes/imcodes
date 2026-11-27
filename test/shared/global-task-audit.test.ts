import { describe, expect, it } from 'vitest';
import {
  GLOBAL_TASK_AUDIT_SUMMARY_MAX_CHARS,
  GLOBAL_TASK_PG_NOTIFY_MAX_BYTES,
  normalizeGlobalTaskAuditSummary,
  serializeBoundedPgNotifyPayload,
  type GlobalTaskSummaryRow,
} from '../../shared/global-task-mode.js';
import {
  buildGlobalTaskAuditSummary,
  extractAuditFindingsFromVerdict,
} from '../../shared/task-pair-brief.js';
import type { TaskPairLastVerdict } from '../../shared/task-pair.js';

describe('global task structured audit summary & extraction', () => {
  it('extracts full untruncated numbered findings from fullNoticeText beyond 4000/2000 char caps', () => {
    const padding = 'A'.repeat(2300);
    const tailSentinel = 'SENTINEL_TAIL_ISSUE_4_AT_6000';
    const tailProposalSentinel = 'SENTINEL_TAIL_PROPOSAL_FIX_999';
    const fullReply = [
      'Summary: Three P0 defects and one P1 edge case remain.',
      '',
      `1. [P0] First defect (${padding})`,
      'Location: src/daemon/foo.ts:12',
      'Proposal: Fix first invariant.',
      '',
      `2. [P0] Second defect (${padding})`,
      'Location: src/daemon/bar.ts:34',
      'Proposal: Fix second invariant.',
      '',
      '3. [P1] Third minor issue without blocking',
      '位置: server/src/ws/bridge.ts:88',
      '建议: 增加向后兼容兜底。',
      '',
      `4. [P0] Fourth deep issue at end ${tailSentinel}`,
      'Location: web/src/components/GlobalTaskModeView.tsx:1600',
      `Proposal: End-to-end fix ${tailProposalSentinel}`,
    ].join('\n');

    expect(fullReply.length).toBeGreaterThan(5000);

    const verdict: TaskPairLastVerdict = {
      verb: 'REWORK',
      counts: { P0: 3, P1: 1, P2: 0, P3: 0, P4: 0 },
      judgement: 'consistent',
      round: 4,
      noticeText: fullReply.slice(0, 4000),
      fullNoticeText: fullReply,
    };

    const detail = extractAuditFindingsFromVerdict(verdict, ['P0']);
    expect(detail).toBeDefined();
    expect(detail!.verb).toBe('REWORK');
    expect(detail!.round).toBe(4);
    expect(detail!.blockingCount).toBe(3);
    expect(detail!.findingsCount).toBe(4);
    expect(detail!.findings).toHaveLength(4);
    expect(detail!.findings[0]!.summary.length).toBeGreaterThan(2100);
    expect(detail!.findings[2]!.blocking).toBe(false);
    expect(detail!.findings[2]!.location).toBe('server/src/ws/bridge.ts:88');
    expect(detail!.findings[2]!.proposal).toBe('增加向后兼容兜底。');
    expect(detail!.findings[3]).toMatchObject({
      index: 4,
      severity: 'P0',
      blocking: true,
      location: 'web/src/components/GlobalTaskModeView.tsx:1600',
    });
    expect(detail!.findings[3]!.summary).toContain(tailSentinel);
    expect(detail!.findings[3]!.proposal).toContain(tailProposalSentinel);
    expect(detail!.noticeText).toContain(tailProposalSentinel);

    const compact = buildGlobalTaskAuditSummary(verdict, ['P0']);
    expect(compact).toEqual({
      verb: 'REWORK',
      round: 4,
      counts: { p0: 3, p1: 1, p2: 0, p3: 0, p4: 0 },
      blocking: ['P0'],
      blockingCount: 3,
      findingsCount: 4,
      summary: 'Three P0 defects and one P1 edge case remain.',
    });
  });

  it('prefers full structuredDetails, falls back cleanly to numbered prose and PASS without findings', () => {
    const structuredVerdict: TaskPairLastVerdict = {
      verb: 'REWORK',
      counts: { P0: 1, P1: 1, P2: 0, P3: 0, P4: 0 },
      judgement: 'consistent',
      round: 2,
      structuredDetails: {
        summary: 'Two findings from MCP pair_verdict.',
        findings: [
          { severity: 'P0', summary: 'Primary failure', location: 'a.ts:1', proposal: 'Patch A' },
          { severity: 'P1', summary: 'Secondary note', location: 'b.ts:2', proposal: 'Patch B' },
        ],
      },
    };
    const structuredDetail = extractAuditFindingsFromVerdict(structuredVerdict, ['P0', 'P1']);
    expect(structuredDetail!.blockingCount).toBe(2);
    expect(structuredDetail!.findings.map((f) => [f.index, f.severity, f.blocking, f.proposal])).toEqual([
      [1, 'P0', true, 'Patch A'],
      [2, 'P1', true, 'Patch B'],
    ]);

    const numberedVerdict: TaskPairLastVerdict = {
      verb: 'REWORK',
      counts: { P0: 2, P1: 0, P2: 0, P3: 0, P4: 0 },
      judgement: 'consistent',
      round: 1,
      noticeText: '1. Missing error check\n2. Race on retry (P0)',
    };
    const numbered = extractAuditFindingsFromVerdict(numberedVerdict, ['P0']);
    expect(numbered!.findings).toHaveLength(2);
    expect(numbered!.findings[0]!.index).toBe(1);
    expect(numbered!.findings[1]).toMatchObject({ index: 2, severity: 'P0', blocking: true });

    const proseOnlyVerdict: TaskPairLastVerdict = {
      verb: 'REWORK',
      counts: { P0: 1, P1: 0, P2: 0, P3: 0, P4: 0 },
      judgement: 'consistent',
      round: 3,
      noticeText: 'Unsplittable single prose paragraph explaining failure in full detail.',
    };
    const prose = extractAuditFindingsFromVerdict(proseOnlyVerdict, ['P0']);
    expect(prose!.findings).toEqual([]);
    expect(prose!.findingsCount).toBe(1);
    expect(prose!.noticeText).toBe('Unsplittable single prose paragraph explaining failure in full detail.');

    const passVerdict: TaskPairLastVerdict = {
      verb: 'PASS',
      counts: { P0: 0, P1: 0, P2: 2, P3: 0, P4: 0 },
      judgement: 'consistent',
      round: 4,
      noticeText: 'PASS cleanly with two non-blocking P2 follow-ups.',
    };
    const passSummary = buildGlobalTaskAuditSummary(passVerdict, ['P0']);
    expect(passSummary).toEqual({
      verb: 'PASS',
      round: 4,
      counts: { p0: 0, p1: 0, p2: 2, p3: 0, p4: 0 },
      blocking: ['P0'],
      blockingCount: 0,
      findingsCount: 2,
      summary: 'PASS cleanly with two non-blocking P2 follow-ups.',
    });
  });

  it('bounds compact summary <= 160 code points without splitting surrogates and stays within PG NOTIFY 4000B budget', () => {
    const longEmojiSummary = '🚀'.repeat(250);
    const normalized = normalizeGlobalTaskAuditSummary({
      verb: 'REWORK',
      round: 5,
      counts: { p0: 2, p1: 1, p2: 0, p3: 0, p4: 0 },
      blocking: ['P0'],
      summary: longEmojiSummary,
    });
    expect(normalized).toBeDefined();
    expect(Array.from(normalized!.summary!).length).toBeLessThanOrEqual(GLOBAL_TASK_AUDIT_SUMMARY_MAX_CHARS);
    expect(normalized!.summary!.endsWith('…')).toBe(true);

    const row: GlobalTaskSummaryRow = {
      serverId: 'srv-prod-01',
      serverName: 'Production Cluster Node 1',
      serverOnline: true,
      projectName: 'imcodes',
      brainSession: 'deck_imcodes_brain',
      brainLabel: 'Main Brain',
      taskId: 'tsk_notify_budget_check',
      title: '测试标题'.repeat(20),
      status: 'rework',
      flags: ['auditor_silent'],
      round: 5,
      checklist: { total: 5, implemented: 5, audited: 2 },
      executorLabel: 'Worker 1',
      auditorLabel: 'Auditor 1',
      executorModel: 'claude-opus-4-6-high',
      auditorModel: 'gpt-6.2-sol',
      liveSummary: '非常长的现场说明 '.repeat(300),
      lastAudit: normalized,
      createdAt: 1000,
      updatedAt: 2000,
      isTerminal: false,
      needsAttention: true,
    };

    const bounded = serializeBoundedPgNotifyPayload(
      row as unknown as Record<string, unknown>,
      'liveSummary',
      GLOBAL_TASK_PG_NOTIFY_MAX_BYTES,
    );
    expect(Buffer.byteLength(bounded, 'utf8')).toBeLessThanOrEqual(GLOBAL_TASK_PG_NOTIFY_MAX_BYTES);
    expect(JSON.parse(bounded).lastAudit).toEqual(normalized);
  });
});
