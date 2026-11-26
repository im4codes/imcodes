import { describe, expect, it, vi } from 'vitest';
import { scanTaskPairMarkers, stripTaskPairMarkersForDisplay } from '../../shared/task-pair.js';
import {
  hasRetiredSupervisionExecutionMarker,
  parseSupervisionExecutionStateDetailsFromText,
  stripSupervisionExecutionMarkersForDisplay,
} from '../../shared/supervision-config.js';

// Timeline projection and snapshot selection revisit retained completions on
// resume. Assert the causal cost (no line array/fence walk), not wall-clock
// timing, so the guard remains deterministic on slow CI workers.
function countSourceSplits(text: string, action: () => void): number {
  const original = String.prototype.split;
  let calls = 0;
  const spy = vi.spyOn(String.prototype, 'split').mockImplementation(function (this: string, ...args: Parameters<typeof original>) {
    if (String(this) === text) calls++;
    return Reflect.apply(original, this, args);
  });
  try { action(); } finally { spy.mockRestore(); }
  return calls;
}

describe('timeline marker-free resume cost', () => {
  const completion = '1. Preserve the current owner.\n2. Report validation and continue.\n'.repeat(3_000);

  it('does not split ordinary assistant text to look for task-pair markers', () => {
    expect(countSourceSplits(completion, () => {
      expect(scanTaskPairMarkers(completion)).toEqual({ markers: [], markerLineIndexes: [] });
      expect(stripTaskPairMarkersForDisplay(completion)).toBe(completion);
    })).toBe(0);
  });

  it('does not split ordinary assistant text for active or retired execution markers', () => {
    expect(countSourceSplits(completion, () => {
      expect(parseSupervisionExecutionStateDetailsFromText(completion)).toEqual({ state: null, markerCount: 0 });
      expect(stripSupervisionExecutionMarkersForDisplay(completion)).toBe(completion);
      expect(hasRetiredSupervisionExecutionMarker(completion)).toBe(false);
    })).toBe(0);
  });

  it('still scans candidate markers through fences, whitespace and CRLF', () => {
    const task = '  <!--\tIMCODES_TASK CHECK tsk_e2e_cost box=implemented items=1 -->\t';
    const execution = ' <!--\tIMCODES_EXEC: WAITING -->';
    const text = ['```html', task, execution, '```', task, execution].join('\r\n');
    expect(scanTaskPairMarkers(text).markers.map(marker => [marker.verb, marker.lineIndex])).toEqual([['CHECK', 4]]);
    expect(parseSupervisionExecutionStateDetailsFromText(text)).toEqual({ state: 'waiting', markerCount: 1 });
    expect(stripTaskPairMarkersForDisplay(text)).toContain(`\n${execution}`);
    expect(hasRetiredSupervisionExecutionMarker('<!-- IMCODES_EXEC: ADVANCE -->')).toBe(true);
  });
});
