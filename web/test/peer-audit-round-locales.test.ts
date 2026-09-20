import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from '../src/i18n/locales/index.js';

describe('peer audit round translations', () => {
  it('defines the visible chip and accessible label in every supported locale', async () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = (await import(`../src/i18n/locales/${locale}.json`)).default as {
        peerAuditResult?: Record<string, string>;
      };
      expect(messages.peerAuditResult?.roundChip, `${locale}:peerAuditResult.roundChip`)
        .toContain('{{round}}');
      expect(messages.peerAuditResult?.roundAria, `${locale}:peerAuditResult.roundAria`)
        .toContain('{{round}}');
      expect(messages.peerAuditResult?.roundAria, `${locale}:peerAuditResult.roundAria`)
        .toContain('{{outcome}}');
    }
  });
});
