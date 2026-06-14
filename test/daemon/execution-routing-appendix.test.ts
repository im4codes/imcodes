import { describe, it, expect } from 'vitest';
import {
  EXECUTION_CLONE_KIND,
  EXECUTION_CLONE_PARENT_STAGES,
  type ExecutionCloneParentStage,
} from '../../shared/execution-clone.js';
import {
  buildExecutionRoutingAppendix,
  appendExecutionRoutingAppendix,
  EXECUTION_ROUTING_APPENDIX_MARKER,
} from '../../src/daemon/execution-routing-appendix.js';

const STAGE: ExecutionCloneParentStage = 'generic_execution';
const TARGET = 'deck_myapp_exec';

/** Count non-overlapping occurrences of a literal needle in a haystack. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

describe('buildExecutionRoutingAppendix', () => {
  it('produces a non-empty appendix with the full clone call contract when enabled + target', () => {
    const out = buildExecutionRoutingAppendix({
      enabled: true,
      parentStage: STAGE,
      templateTarget: TARGET,
    });

    expect(out.length).toBeGreaterThan(0);
    // Exact call-shape fragments the model must reproduce.
    expect(out).toContain('clone: {');
    expect(out).toContain(`kind: "${EXECUTION_CLONE_KIND}"`);
    expect(out).toContain('kind: "execution_clone"');
    expect(out).toContain('reply: true');
    // Configured template target + stage are substituted in verbatim.
    expect(out).toContain(TARGET);
    expect(out).toContain(`parentStage: "${STAGE}"`);
    // Follow-up via the returned clone.target.
    expect(out).toContain('clone.target');
    // The destroy backstop is named so the model cleans up.
    expect(out).toContain('destroy_execution_clone');
    // Marker is present so insertion is detectable.
    expect(out).toContain(EXECUTION_ROUTING_APPENDIX_MARKER);
  });

  it('returns "" when routing is disabled (even with a valid target)', () => {
    const out = buildExecutionRoutingAppendix({
      enabled: false,
      parentStage: STAGE,
      templateTarget: TARGET,
    });
    expect(out).toBe('');
  });

  it('returns "" when enabled but no template target is configured', () => {
    for (const templateTarget of [undefined, null, '', '   '] as const) {
      const out = buildExecutionRoutingAppendix({
        enabled: true,
        parentStage: STAGE,
        templateTarget,
      });
      expect(out).toBe('');
    }
  });

  it('contains NO OpenSpec-specific wording (stays generic/routing-only)', () => {
    const out = buildExecutionRoutingAppendix({
      enabled: true,
      parentStage: 'openspec_implementation',
      templateTarget: TARGET,
    });
    // The appendix must never inject task semantics — that belongs to the entry
    // point. parentStage values like "openspec_implementation" are machine
    // identifiers and are excluded from this prose check.
    const withoutMarkerAndStage = out
      .split('\n')
      .filter(
        (line) =>
          !line.includes(EXECUTION_ROUTING_APPENDIX_MARKER) &&
          !line.includes('parentStage:'),
      )
      .join('\n');
    expect(withoutMarkerAndStage).not.toMatch(/openspec|requirement|change\b|spec\b/i);
  });

  it('reflects every parent stage value verbatim', () => {
    for (const stage of EXECUTION_CLONE_PARENT_STAGES) {
      const out = buildExecutionRoutingAppendix({
        enabled: true,
        parentStage: stage,
        templateTarget: TARGET,
      });
      expect(out).toContain(`parentStage: "${stage}"`);
    }
  });
});

describe('appendExecutionRoutingAppendix', () => {
  const base = 'Implement the requested work for this task.';

  it('appends the appendix with a blank-line separator when enabled', () => {
    const out = appendExecutionRoutingAppendix(base, {
      enabled: true,
      parentStage: STAGE,
      templateTarget: TARGET,
    });
    expect(out.startsWith(base)).toBe(true);
    expect(out).toContain(`\n\n${EXECUTION_ROUTING_APPENDIX_MARKER}`);
    expect(out).toContain('clone: {');
  });

  it('returns the base prompt unchanged when routing is disabled', () => {
    const out = appendExecutionRoutingAppendix(base, {
      enabled: false,
      parentStage: STAGE,
      templateTarget: TARGET,
    });
    expect(out).toBe(base);
  });

  it('returns the base prompt unchanged when no template target is configured', () => {
    const out = appendExecutionRoutingAppendix(base, {
      enabled: true,
      parentStage: STAGE,
      templateTarget: null,
    });
    expect(out).toBe(base);
  });

  it('appends exactly once even when called twice on the same prompt (idempotent)', () => {
    const opts = { enabled: true, parentStage: STAGE, templateTarget: TARGET };
    const once = appendExecutionRoutingAppendix(base, opts);
    const twice = appendExecutionRoutingAppendix(once, opts);

    expect(twice).toBe(once);
    expect(countOccurrences(twice, EXECUTION_ROUTING_APPENDIX_MARKER)).toBe(1);
  });
});
