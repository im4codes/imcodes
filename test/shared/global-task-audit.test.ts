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
import { parseTaskPairAuditDetails } from '../../shared/task-pair-notification.js';
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

  it('parses mixed [P0] + unbracketed numbered/bullet findings, multi-paragraph fields, plain numbered fields, preserves __ paths, and keeps saved auditDetails fields', () => {
    const mixedReply = [
      'Summary: Mixed format audit.',
      '',
      '1. [P0] First tagged finding',
      '',
      'Second paragraph describing first finding impact.',
      'Location: src/a__b.ts:12',
      'Proposal: Fix first invariant.',
      '',
      'Second paragraph of first proposal.',
      '',
      '2. Second plain numbered finding (P1)',
      'Location: src/nested/__init__.py:44',
      'Proposal: Fix second item cleanly.',
      '',
      '- Third plain bullet finding',
      'Proposal: Fix third item cleanly.',
    ].join('\n');

    const mixed = extractAuditFindingsFromVerdict({
      verb: 'REWORK',
      counts: { P0: 1, P1: 1, P2: 0, P3: 0, P4: 0 },
      judgement: 'consistent',
      round: 2,
      fullNoticeText: mixedReply,
      noticeText: mixedReply,
    }, ['P0']);

    expect(mixed?.findings).toHaveLength(3);
    expect(mixed?.findings[0]).toMatchObject({
      index: 1,
      severity: 'P0',
      blocking: true,
      location: 'src/a__b.ts:12',
    });
    expect(mixed?.findings[0]!.summary).toContain('Second paragraph describing first finding impact.');
    expect(mixed?.findings[0]!.proposal).toContain('Fix first invariant.');
    expect(mixed?.findings[0]!.proposal).toContain('Second paragraph of first proposal.');
    expect(mixed?.findings[0]!.proposal).not.toContain('Fix second item cleanly.');
    expect(mixed?.findings[1]).toMatchObject({
      index: 2,
      severity: 'P1',
      blocking: false,
      location: 'src/nested/__init__.py:44',
      proposal: 'Fix second item cleanly.',
    });
    expect(mixed?.findings[2]).toMatchObject({
      index: 3,
      blocking: false,
      summary: 'Third plain bullet finding',
      proposal: 'Fix third item cleanly.',
    });

    const plainNumberedReply = [
      '1. Missing validation guard on upload',
      '',
      'Continuation paragraph after blank line.',
      'Location: server/src/a__handler.ts:90',
      'Proposal: Validate size before write.',
      '',
      '2. Missing timeout cleanup',
      'Location: src/daemon/b__worker.ts:15',
      'Proposal: Clear timer on abort.',
    ].join('\n');

    const plainNumbered = extractAuditFindingsFromVerdict({
      verb: 'REWORK',
      counts: { P0: 2, P1: 0, P2: 0, P3: 0, P4: 0 },
      judgement: 'consistent',
      round: 3,
      fullNoticeText: plainNumberedReply,
      noticeText: plainNumberedReply,
    }, ['P0']);

    expect(plainNumbered?.findings).toHaveLength(2);
    expect(plainNumbered?.findings[0]).toMatchObject({
      index: 1,
      location: 'server/src/a__handler.ts:90',
      proposal: 'Validate size before write.',
    });
    expect(plainNumbered?.findings[0]!.summary).toContain('Continuation paragraph after blank line.');
    expect(plainNumbered?.findings[1]).toMatchObject({
      index: 2,
      location: 'src/daemon/b__worker.ts:15',
      proposal: 'Clear timer on abort.',
    });

    // Existing saved auditDetails (with location + proposal) must not be clobbered by a short 1-line noticeText
    const preserved = extractAuditFindingsFromVerdict({
      verb: 'REWORK',
      counts: { P0: 1, P1: 0, P2: 0, P3: 0, P4: 0 },
      judgement: 'consistent',
      round: 1,
      noticeText: '[P0] Short summary headline only',
      auditDetails: {
        findings: [
          {
            severity: 'P0',
            summary: 'Full structured summary headline',
            location: 'src/saved__path.ts:77',
            proposal: 'Keep saved proposal intact',
          },
        ],
      },
    }, ['P0']);

    expect(preserved?.findings).toEqual([
      {
        index: 1,
        severity: 'P0',
        blocking: true,
        summary: 'Full structured summary headline',
        location: 'src/saved__path.ts:77',
        proposal: 'Keep saved proposal intact',
      },
    ]);

    // Unapplied (inconsistent / missing_severity) verdicts must return undefined so held PASS never appears as Passed
    expect(extractAuditFindingsFromVerdict({
      verb: 'PASS',
      counts: { P0: 1, P1: 0, P2: 0, P3: 0, P4: 0 },
      judgement: 'inconsistent',
      round: 4,
      noticeText: '[P0] Still broken PASS attempt',
    }, ['P0'])).toBeUndefined();
    expect(buildGlobalTaskAuditSummary({
      verb: 'REWORK',
      counts: { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 },
      judgement: 'missing_severity',
      round: 4,
      noticeText: 'REWORK without severities',
    }, ['P0'])).toBeUndefined();
  });

  it('preserves exact order, severity, location, and proposal when real parseTaskPairAuditDetails drops unbracketed items, and keeps zero-finding PASS Verification lines out of findings', () => {
    const mixedDaemonNotice = [
      '- [P0] First problem in bridge handler',
      'Location: server/src/ws/bridge.ts:10',
      'Proposal: Fix first problem only.',
      '',
      '2. Second problem (P0) unbracketed item',
      'Location: shared/task-pair-brief.ts:255',
      'Proposal: Fix second problem cleanly.',
      '',
      '- [P1] Third problem non-blocking follow-up',
      'Location: web/src/components/GlobalTaskBriefModal.tsx:415',
      'Proposal: Fix third problem gently.',
    ].join('\n');

    // Simulate real daemon service.ts:1049 persistence (`parseTaskPairAuditDetails` misses item #2 and cross-attributes its fields)
    const persistedAuditDetails = parseTaskPairAuditDetails(mixedDaemonNotice);
    expect(persistedAuditDetails?.findings).toHaveLength(2);

    const extracted = extractAuditFindingsFromVerdict({
      verb: 'REWORK',
      counts: { P0: 2, P1: 1, P2: 0, P3: 0, P4: 0 },
      judgement: 'consistent',
      round: 2,
      noticeText: mixedDaemonNotice.slice(0, 4000),
      fullNoticeText: mixedDaemonNotice,
      auditDetails: persistedAuditDetails,
    }, ['P0']);

    expect(extracted?.findings).toHaveLength(3);
    expect(extracted?.findings[0]).toMatchObject({
      index: 1,
      severity: 'P0',
      blocking: true,
      summary: 'First problem in bridge handler',
      location: 'server/src/ws/bridge.ts:10',
      proposal: 'Fix first problem only.',
    });
    expect(extracted?.findings[1]).toMatchObject({
      index: 2,
      severity: 'P0',
      blocking: true,
      summary: 'Second problem (P0) unbracketed item',
      location: 'shared/task-pair-brief.ts:255',
      proposal: 'Fix second problem cleanly.',
    });
    expect(extracted?.findings[2]).toMatchObject({
      index: 3,
      severity: 'P1',
      blocking: false,
      summary: 'Third problem non-blocking follow-up',
      location: 'web/src/components/GlobalTaskBriefModal.tsx:415',
      proposal: 'Fix third problem gently.',
    });

    // Zero-finding PASS with ## Verification checklist must yield 0 findings (not 2)
    const zeroPassReply = [
      'Summary: All acceptance criteria verified and clean.',
      '',
      '## Verification',
      '1. Ran full daemon and shared suites (98/98 passed).',
      '2. Verified Chromium height parity test (3/3 passed).',
    ].join('\n');
    const passDetail = extractAuditFindingsFromVerdict({
      verb: 'PASS',
      counts: { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 },
      judgement: 'consistent',
      round: 3,
      noticeText: zeroPassReply,
      fullNoticeText: zeroPassReply,
      auditDetails: parseTaskPairAuditDetails(zeroPassReply),
    }, ['P0']);
    expect(passDetail?.findings).toEqual([]);
    expect(passDetail?.findingsCount).toBe(0);
    expect(passDetail?.noticeText).toContain('Ran full daemon and shared suites');

    // PASS with P2=1 + ## Verification + ## Findings includes only the P2 finding
    const passWithFollowUp = [
      'Summary: Clean PASS with one optional P2 follow-up.',
      '',
      '## Verification',
      '- Passed server tests (16/16).',
      '- Passed web tests (105/105).',
      '',
      '## Findings',
      '1. [P2] Clarify warning copy',
      'Proposal: Update copy in next cleanup.',
    ].join('\n');
    const passFollowUpDetail = extractAuditFindingsFromVerdict({
      verb: 'PASS',
      counts: { P0: 0, P1: 0, P2: 1, P3: 0, P4: 0 },
      judgement: 'consistent',
      round: 4,
      noticeText: passWithFollowUp,
      fullNoticeText: passWithFollowUp,
    }, ['P0']);
    expect(passFollowUpDetail?.findings).toHaveLength(1);
    expect(passFollowUpDetail?.findings[0]).toMatchObject({
      index: 1,
      severity: 'P2',
      blocking: false,
      summary: 'Clarify warning copy',
      proposal: 'Update copy in next cleanup.',
    });
  });

  it('never cross-swaps location or proposal when structuredDetails and independent notice use reversed order, different wording, or shared prefixes', () => {
    // 1. Same length, reversed order, matching full summaries -> each keeps/gets ONLY its own fields (never index-swapped)
    const reversedExact = extractAuditFindingsFromVerdict({
      verb: 'REWORK',
      counts: { P0: 1, P1: 1, P2: 0, P3: 0, P4: 0 },
      judgement: 'consistent',
      round: 2,
      structuredDetails: {
        findings: [
          { severity: 'P0', summary: 'First problem' },
          { severity: 'P1', summary: 'Second problem' },
        ],
      },
      fullNoticeText: [
        '- [P1] Second problem',
        'Location: src/second.ts:20',
        'Proposal: SECOND_FIX',
        '',
        '- [P0] First problem',
        'Location: src/first.ts:10',
        'Proposal: FIRST_FIX',
      ].join('\n'),
    }, ['P0']);

    expect(reversedExact?.findings).toEqual([
      {
        index: 1,
        severity: 'P0',
        blocking: true,
        summary: 'First problem',
        location: 'src/first.ts:10',
        proposal: 'FIRST_FIX',
      },
      {
        index: 2,
        severity: 'P1',
        blocking: false,
        summary: 'Second problem',
        location: 'src/second.ts:20',
        proposal: 'SECOND_FIX',
      },
    ]);

    // 2. Same length, reversed order, independent notice wording (or shared 32-char prefix ambiguity) -> keeps structured fields cleanly without swapping or prefix-guessing
    const sharedPrefix = 'Shared 32-char diagnostic prefix across entries: ';
    const reversedIndependent = extractAuditFindingsFromVerdict({
      verb: 'REWORK',
      counts: { P0: 1, P1: 1, P2: 0, P3: 0, P4: 0 },
      judgement: 'consistent',
      round: 2,
      structuredDetails: {
        findings: [
          { severity: 'P0', summary: `${sharedPrefix}First structured item`, location: 'src/struct-first.ts:1' },
          { severity: 'P1', summary: `${sharedPrefix}Second structured item` },
        ],
      },
      fullNoticeText: [
        `- [P1] ${sharedPrefix}Independent second note`,
        'Location: src/second.ts:20',
        'Proposal: SECOND_FIX',
        '',
        `- [P0] ${sharedPrefix}Independent first note`,
        'Location: src/first.ts:10',
        'Proposal: FIRST_FIX',
      ].join('\n'),
    }, ['P0']);

    expect(reversedIndependent?.findings).toEqual([
      {
        index: 1,
        severity: 'P0',
        blocking: true,
        summary: `${sharedPrefix}First structured item`,
        location: 'src/struct-first.ts:1',
      },
      {
        index: 2,
        severity: 'P1',
        blocking: false,
        summary: `${sharedPrefix}Second structured item`,
      },
    ]);
    expect(reversedIndependent?.noticeText).toContain('SECOND_FIX');
    expect(reversedIndependent?.noticeText).toContain('FIRST_FIX');

    // 3. Duplicate identical summary across items in notice -> ambiguity guard refuses cross-fill instead of guessing
    const ambiguousDuplicates = extractAuditFindingsFromVerdict({
      verb: 'REWORK',
      counts: { P0: 2, P1: 0, P2: 0, P3: 0, P4: 0 },
      judgement: 'consistent',
      round: 3,
      structuredDetails: {
        findings: [
          { severity: 'P0', summary: 'Duplicate check headline' },
          { severity: 'P0', summary: 'Duplicate check headline' },
        ],
      },
      fullNoticeText: [
        '- [P0] Duplicate check headline',
        'Location: src/a.ts:1',
        'Proposal: FIX_A',
        '',
        '- [P0] Duplicate check headline',
        'Location: src/b.ts:2',
        'Proposal: FIX_B',
      ].join('\n'),
    }, ['P0']);

    expect(ambiguousDuplicates?.findings).toEqual([
      { index: 1, severity: 'P0', blocking: true, summary: 'Duplicate check headline' },
      { index: 2, severity: 'P0', blocking: true, summary: 'Duplicate check headline' },
    ]);
  });
});
