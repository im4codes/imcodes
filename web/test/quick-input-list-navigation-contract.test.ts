import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { moveListboxIndex, normalizeListboxIndex } from '../src/hooks/useListboxNavigation.js';

const WEB_ROOT = resolve(__dirname, '..');

describe('# @ ; ^ shared keyboard-list navigation contract', () => {
  it('routes all four composer shortcut lists through the same hook', () => {
    const controls = readFileSync(resolve(WEB_ROOT, 'src/components/SessionControls.tsx'), 'utf8');
    const atPicker = readFileSync(resolve(WEB_ROOT, 'src/components/AtPicker.tsx'), 'utf8');
    const shared = readFileSync(resolve(WEB_ROOT, 'src/hooks/useListboxNavigation.ts'), 'utf8');

    // SessionControls owns # phrases, ; aliases, and ^ machines. @ is hosted by
    // AtPicker. Keeping this call-count contract prevents the next shortcut
    // list from quietly returning to one-off Arrow/scroll logic.
    expect(controls.match(/useListboxNavigation\(\{/g)).toHaveLength(3);
    expect(atPicker.match(/useListboxNavigation\(\{/g)).toHaveLength(1);
    expect(shared).toContain("scrollIntoView({ block: 'nearest' })");
    expect(shared).toContain("'PageUp'");
    expect(shared).toContain("'PageDown'");
    expect(shared).toContain("'Home'");
    expect(shared).toContain("'End'");
  });

  it('wraps, pages, and skips non-selectable rows in the shared index calculation', () => {
    const selectable = [0, 2, 4, 7];
    expect(moveListboxIndex(0, 'ArrowUp', selectable)).toBe(7);
    expect(moveListboxIndex(7, 'ArrowDown', selectable)).toBe(0);
    expect(moveListboxIndex(0, 'ArrowDown', selectable)).toBe(2);
    expect(moveListboxIndex(2, 'Home', selectable)).toBe(0);
    expect(moveListboxIndex(2, 'End', selectable)).toBe(7);
    expect(moveListboxIndex(0, 'PageDown', selectable, 2)).toBe(4);
    expect(moveListboxIndex(4, 'PageUp', selectable, 2)).toBe(0);
  });

  it('normalizes a removed or filtered active row to an in-range selectable row', () => {
    expect(normalizeListboxIndex(9, [0, 2, 4])).toBe(0);
    expect(normalizeListboxIndex(3, [0, 2, 4])).toBe(4);
    expect(normalizeListboxIndex(2, [0, 2, 4])).toBe(2);
    expect(normalizeListboxIndex(5, [])).toBe(0);
  });
});
