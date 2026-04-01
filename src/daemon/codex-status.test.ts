import { describe, expect, it } from 'vitest';
import { normalizeCodexStatusPaneText, parseCodexStatusOutput } from './codex-status.js';

describe('codex status parsing', () => {
  it('parses context, 5h, and weekly limits from /status output', () => {
    const raw = `
      \u001b[38;5;39mContext window:\u001b[0m 36% left (169K used / 258K)
      5h limit: 43% left (resets 14:13)
      Weekly limit: 34% left (resets 02:11 on 4 Apr)
    `;
    const parsed = parseCodexStatusOutput(raw);
    expect(parsed).toMatchObject({
      contextLeftPercent: 36,
      contextUsedTokens: 169_000,
      contextWindowTokens: 258_000,
      fiveHourLeftPercent: 43,
      fiveHourResetAt: '14:13',
      weeklyLeftPercent: 34,
      weeklyResetAt: '02:11 on 4 Apr',
    });
  });

  it('normalizes pane chrome before parsing', () => {
    const raw = '│ Weekly limit: 34% left (resets 02:11 on 4 Apr)\r\n';
    expect(normalizeCodexStatusPaneText(raw)).toBe('Weekly limit: 34% left (resets 02:11 on 4 Apr)');
  });
});
