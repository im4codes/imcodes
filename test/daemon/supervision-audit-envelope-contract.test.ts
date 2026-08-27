/**
 * The audit envelope a prompt TELLS a model to send must be one the daemon
 * actually accepts.
 *
 * These two sides drifted: `auditedSessionName` became required by the schema
 * and the parser, while all seven localized re-audit examples still emitted
 * only kind+attemptId. A model following its instructions verbatim would have
 * had every re-audit rejected as `invalid`, silently breaking the REWORK loop.
 *
 * So this test does not re-state the expected shape. It extracts the envelope
 * out of the rendered prompt and feeds it to the real parser, for every locale
 * and for both the initial and REWORK call.
 */
import { describe, expect, it } from 'vitest';
import { SUPERVISION_SUPPORTED_UI_LOCALES } from '../../shared/supervision-config.js';
import {
  buildAutomaticAuditTaskPrompt,
  buildReworkBriefPrompt,
} from '../../src/daemon/supervision-prompts.js';
import { parseAuditArg } from '../../src/daemon/memory-mcp-tools.js';

const AUDITED = 'deck_alpha_impl';
const AUDITOR = 'deck_beta_auditor';
/** Prompts print a human placeholder here; the parser needs a real opaque id. */
const VALID_ATTEMPT = 'attempt-abc123';

function extractEnvelope(prompt: string): unknown {
  const match = prompt.match(/\{"kind":"supervision_audit"[^}]*\}/);
  if (!match) throw new Error('prompt emitted no supervision_audit envelope');
  return JSON.parse(match[0].replace(/"attemptId":"[^"]*"/, `"attemptId":"${VALID_ATTEMPT}"`));
}

describe('supervision audit envelope contract', () => {
  it.each(SUPERVISION_SUPPORTED_UI_LOCALES)(
    'REWORK re-audit example in %s is accepted by the real parser',
    (uiLocale) => {
      const prompt = buildReworkBriefPrompt(
        AUDITED, 'task', 'last', 'findings', { attempt: 1, limit: 3 }, AUDITOR, uiLocale,
      );
      const parsed = parseAuditArg(extractEnvelope(prompt));
      expect(parsed).not.toBe('invalid');
      // The audited session is the one doing the rework -- never the auditor.
      expect(parsed).toMatchObject({ attemptId: VALID_ATTEMPT, auditedSessionName: AUDITED });
      expect((parsed as { auditedSessionName: string }).auditedSessionName).not.toBe(AUDITOR);
    },
  );

  it('initial automatic audit envelope is accepted by the real parser', () => {
    const prompt = buildAutomaticAuditTaskPrompt({
      attemptId: VALID_ATTEMPT, targetSession: AUDITOR, auditedSessionName: AUDITED, narrow: true,
    });
    expect(parseAuditArg(extractEnvelope(prompt)))
      .toMatchObject({ attemptId: VALID_ATTEMPT, auditedSessionName: AUDITED });
  });

  it('rejects an envelope that omits the audited session', () => {
    expect(parseAuditArg({ kind: 'supervision_audit', attemptId: VALID_ATTEMPT })).toBe('invalid');
  });

  it('rejects a blank or whitespace-padded audited session', () => {
    for (const auditedSessionName of ['', '   ', ' deck_alpha_impl']) {
      expect(parseAuditArg({ kind: 'supervision_audit', attemptId: VALID_ATTEMPT, auditedSessionName }))
        .toBe('invalid');
    }
  });
});
