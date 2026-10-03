import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('peer audit round chip styles', () => {
  const css = readFileSync(resolve(import.meta.dirname, '../src/styles.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, '');

  it('keeps the result summary mobile-safe and the round chip compact', () => {
    const row = css.match(/\.peer-audit-result-verdict-row\s*\{[^}]*\}/u)?.[0];
    expect(row).toMatch(/display:\s*flex/u);
    expect(row).toMatch(/flex-wrap:\s*wrap/u);
    expect(row).toMatch(/min-width:\s*0/u);

    const shared = css.match(/\.peer-audit-result-outcome,\s*\.peer-audit-round-chip\s*\{[^}]*\}/u)?.[0];
    expect(shared).toMatch(/flex:\s*0\s+0\s+auto/u);
    expect(shared).toMatch(/white-space:\s*nowrap/u);

    const delegationMeta = css.match(/\.delegation-reply-card-meta\s*\{[^}]*\}/u)?.[0];
    expect(delegationMeta).toMatch(/display:\s*flex/u);
    expect(delegationMeta).toMatch(/flex-wrap:\s*wrap/u);
    expect(delegationMeta).toMatch(/min-width:\s*0/u);
  });
});
