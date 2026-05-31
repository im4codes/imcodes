import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cssPath = existsSync('src/styles.css') ? 'src/styles.css' : 'web/src/styles.css';
const css = readFileSync(cssPath, 'utf8');

function declarationBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
}

describe('discussions layout CSS', () => {
  it('constrains discussion detail width so long content cannot push controls outside the window', () => {
    const page = declarationBlock('.discussions-page');
    const layout = declarationBlock('.discussions-layout');
    const detail = declarationBlock('.discussions-detail');
    const scroll = declarationBlock('.discussions-detail-scroll');
    const nav = declarationBlock('.discussions-nav-row');

    expect(page).toContain('min-width: 0');
    expect(layout).toContain('min-width: 0');
    expect(detail).toContain('min-width: 0');
    expect(detail).toContain('overflow: hidden');
    expect(scroll).toContain('max-width: 100%');
    expect(nav).toContain('box-sizing: border-box');
    expect(nav).toContain('max-width: 100%');
  });

  it('constrains embedded discussion progress cards inside floating windows', () => {
    const panel = declarationBlock('.discussion-panel');
    const card = declarationBlock('.discussions-progress-card');
    const lines = declarationBlock('.discussions-progress-lines');
    const segments = declarationBlock('.discussions-progress-segments');
    const nodes = declarationBlock('.discussions-progress-nodes');

    expect(panel).toContain('min-width: 0');
    expect(panel).toContain('max-width: 100%');
    expect(panel).toContain('overflow: hidden');
    expect(card).toContain('min-width: 0');
    expect(card).toContain('max-width: 100%');
    expect(card).toContain('box-sizing: border-box');
    expect(lines).toContain('min-width: 0');
    expect(segments).toContain('max-width: 100%');
    expect(nodes).toContain('overflow-x: auto');
    expect(nodes).toContain('min-width: 0');
    expect(nodes).toContain('max-width: 100%');
  });

  it('wraps long discussion markdown, inline code, code blocks, and table cells', () => {
    const markdown = declarationBlock('.discussions-file-preview .fb-preview-md');
    const prose = declarationBlock('.discussions-file-preview .fb-preview-md p,\n.discussions-file-preview .fb-preview-md li,\n.discussions-file-preview .fb-preview-md blockquote,\n.discussions-file-preview .fb-preview-md code,\n.discussions-file-preview .fb-preview-md pre,\n.discussions-file-preview .fb-preview-md pre code');
    const table = declarationBlock('.discussions-file-preview .fb-preview-md table');
    const cells = declarationBlock('.discussions-file-preview .fb-preview-md th,\n.discussions-file-preview .fb-preview-md td');

    expect(markdown).toContain('overflow-wrap: anywhere');
    expect(prose).toContain('white-space: pre-wrap');
    expect(prose).toContain('overflow-wrap: anywhere');
    expect(table).toContain('table-layout: fixed');
    expect(cells).toContain('white-space: normal');
    expect(cells).toContain('overflow-wrap: anywhere');
  });
});
