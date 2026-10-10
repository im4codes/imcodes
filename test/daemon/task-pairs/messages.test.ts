import { describe, expect, it } from 'vitest';
import { scanTaskPairMarkers, type TaskPairState } from '../../../shared/task-pair.js';
import { buildAuditorAssignmentMessage, buildAuditRequestMessage, buildBriefEndHint, buildExecutorHandoffMessage, buildNoBriefLine, buildNudgeMessage, buildUntitledTaskTitleRequest } from '../../../src/daemon/task-pairs/messages.js';

function basePair(overrides: Partial<TaskPairState> = {}): TaskPairState {
  return {
    taskId: 'tsk_x', brain: 'deck_proj_brain', executor: 'deck_sub_exec', auditor: 'deck_sub_aud',
    status: 'in_audit', flags: [], flagSides: {}, round: 1, blocking: ['P0'], previousAuditors: [],
    capCounts: {}, capRound: 1, createdAt: 1, updatedAt: 1,
    ...overrides,
  };
}

/**
 * Regression (tsk_cd_pair_import_briefless r1 audit): a backtick-wrapped
 * marker example silently fails `MARKER_LINE_RE`/`briefEndLineRe`
 * (shared/task-pair.ts), which only accept a bare `<!-- ... -->` line. Every
 * agent-facing instruction and Brain notice is built from `marker()` /
 * `buildBriefEndHint()`; if an agent copies the shown example verbatim onto
 * its own line, it must actually parse, or the pair hangs.
 */
describe('daemon-authored marker examples parse when copied verbatim onto their own line', () => {
  it('describes title reminders as non-terminal metadata updates', () => {
    const text = buildUntitledTaskTitleRequest(['tsk_x'], 'en');
    expect(text).toContain('pair_task_update({taskId,title})');
    expect(text).toContain('title-only');
    expect(text).toContain('never reopens');
    expect(text).toContain('cancelled/done');
  });
  it('includes the auditor proposal rule in assignment and audit-request briefs', () => {
    const pair = basePair({ material: { path: '/workspace', at: 1 } });
    expect(buildAuditorAssignmentMessage(pair)).toMatch(/concrete solution/);
    expect(buildAuditRequestMessage(pair, { path: '/workspace', source: 'executor' })).toMatch(/concrete solution/);
  });

  it('gives a reassigned executor the authoritative absolute workspace, base, and latest head', () => {
    const text = buildExecutorHandoffMessage({
      ...basePair({
        status: 'working',
        workspace: {
          kind: 'worktree', path: '/Users/k/.imcodes/worktrees/pair_tsk_x/repo',
          base: 'base-sha', lastHead: 'head-sha', status: 'active', createdAt: 1,
        },
      }),
      material: { worktree: '/Users/k/.imcodes/worktrees/pair_tsk_x/repo', base: 'base-sha', head: 'head-sha', at: 2 },
    }, 'deck_sub_old_exec', 'provider limit');
    expect(text).toContain('/Users/k/.imcodes/worktrees/pair_tsk_x/repo');
    expect(text).toContain('base base-sha');
    expect(text).toContain('latest head head-sha');
    expect(text).toContain('never use cwd or the project main checkout');
  });
  it('buildNoBriefLine teaches Brain the MCP tools, not a QUEUE marker (a legacy QUEUE marker still parses)', () => {
    const text = buildNoBriefLine('tsk_x');
    expect(text).toContain('pair_task_update');
    expect(text).toContain('pair_dispatch');
    expect(text).toContain('pair_create');
    expect(text).not.toMatch(/<!--\s*IMCODES_TASK/);
    // Compatibility: the daemon still accepts the old marker from an existing Brain.
    const { markers } = scanTaskPairMarkers('<!-- IMCODES_TASK QUEUE tsk_x title="x" -->');
    expect(markers[0]).toMatchObject({ knownVerb: 'QUEUE', taskId: 'tsk_x' });
  });

  it('a copied END hint closes a QUEUE brief', () => {
    const queueLine = '<!-- IMCODES_TASK QUEUE tsk_x title="x" -->';
    const endLine = buildBriefEndHint('tsk_x');
    const text = `${queueLine}\nthe brief text\n${endLine}`;
    const { markers } = scanTaskPairMarkers(text);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ knownVerb: 'QUEUE', taskId: 'tsk_x', brief: 'the brief text' });
    expect(markers[0]!.briefMissing).toBeUndefined();
  });

  it('a PASS marker extracted from the auditor nudge parses to the right verb and taskId', () => {
    const text = buildNudgeMessage(basePair(), 'auditor');
    const markerLine = text.match(/<!-- IMCODES_TASK PASS.*?-->/)?.[0];
    expect(markerLine).toBeTruthy();
    const { markers } = scanTaskPairMarkers(markerLine!);
    expect(markers[0]).toMatchObject({ knownVerb: 'PASS', taskId: 'tsk_x', attrs: { blocking: 'P0' } });
  });

  it('never wraps a marker or brief-end example in backticks', () => {
    for (const text of [
      buildNoBriefLine('tsk_x'),
      buildNudgeMessage(basePair(), 'auditor'),
      buildNudgeMessage(basePair({ status: 'awaiting_audit' }), 'executor'),
      buildBriefEndHint('tsk_x'),
    ]) {
      expect(text).not.toContain('`');
    }
  });
});
