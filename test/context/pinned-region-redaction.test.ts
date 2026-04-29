import { describe, expect, it } from 'vitest';
import { ensurePinnedNotesSection, redactSummaryPreservingPinned } from '../../src/util/redact-with-pinned-region.js';
import { localOnlyCompressor } from '../../src/context/summary-compressor.js';
import type { ContextModelConfig, LocalContextEvent } from '../../shared/context-types.js';

const bearer = `Bearer ${'a'.repeat(24)}`;
const gitSha = '0123456789abcdef0123456789abcdef01234567';
const longHex = 'a'.repeat(64);

const modelConfig: ContextModelConfig = {
  primaryContextBackend: 'codex-sdk',
  primaryContextModel: 'gpt-5.2',
};

describe('pinned-note summary redaction', () => {
  it('preserves token-shaped pinned-note bytes while redacting outside the pinned section', () => {
    const pinned = [
      `Always rebase onto ${gitSha}`,
      'Document examples may say password: required',
      `Fixture hash ${longHex}`,
      'Preserve trailing spaces   ',
    ];
    const summary = [
      '## User Problem',
      `Outside token ${bearer}`,
      '',
      '## User-Pinned Notes',
      ...pinned,
      '',
      '## Active State',
      `Outside again ${bearer}`,
    ].join('\n');

    const redacted = redactSummaryPreservingPinned(summary);

    for (const note of pinned) expect(redacted).toContain(note);
    expect(redacted).toContain('[REDACTED:bearer]');
    expect(redacted).not.toContain(`Outside token ${bearer}`);
    expect(redacted).not.toContain(`Outside again ${bearer}`);
  });

  it('repairs an altered or missing pinned block with exact side-table content', () => {
    const pinned = [`Remember exact commit ${gitSha}`];
    const summary = [
      '## User Problem',
      'Keep a release note.',
      '',
      '## User-Pinned Notes',
      'Remember exact commit [REDACTED:hex40]',
      '',
      '## Active State',
      'Done.',
    ].join('\n');

    const repaired = ensurePinnedNotesSection(summary, pinned);

    expect(repaired).toContain(`## User-Pinned Notes\n${pinned[0]}\n\n## Active State`);
    expect(repaired).toContain(gitSha);
  });

  it('local-only summaries append pinned notes byte-identically for materialization tests', async () => {
    const pinned = [`Keep markdown too\n## Literal pinned heading\n${gitSha}`];
    const events: LocalContextEvent[] = [{
      id: 'evt-1',
      target: {
        namespace: { scope: 'personal', projectId: 'repo', userId: 'user-1' },
        kind: 'session',
        sessionName: 'deck_repo_brain',
      },
      eventType: 'user.turn',
      content: `outside ${bearer}`,
      metadata: {},
      createdAt: 1,
    }];

    const result = await localOnlyCompressor({
      events,
      modelConfig,
      pinnedNotes: pinned,
    });

    expect(result.summary).toContain(pinned[0]);
    expect(result.summary).toContain('[REDACTED:bearer]');
    expect(result.summary).not.toContain(bearer);
  });
});
