import { describe, expect, it } from 'vitest';
import { scanTaskPairMarkers, type TaskPairState } from '../../../shared/task-pair.js';
import { buildBriefEndHint, buildNoBriefLine, buildNudgeMessage } from '../../../src/daemon/task-pairs/messages.js';

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
  it('a QUEUE marker extracted from buildNoBriefLine parses to the right verb and taskId', () => {
    const text = buildNoBriefLine('tsk_x');
    const markerLine = text.match(/<!-- IMCODES_TASK\s.*?-->/)?.[0];
    expect(markerLine).toBeTruthy();
    const { markers } = scanTaskPairMarkers(markerLine!);
    expect(markers).toHaveLength(1);
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
