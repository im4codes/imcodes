import { describe, expect, it } from 'vitest';
import {
  buildServerIconLabels,
  serverIconLabelUnits,
  splitServerIconGraphemes,
  SERVER_ICON_LABEL_EMPTY,
  SERVER_ICON_LABEL_LINE_UNITS,
  SERVER_ICON_LABEL_SIZES,
} from '../../shared/server-icon-label.js';

const texts = (names: string[]) => buildServerIconLabels(names).map((label) => label.lines.join('/'));
const unique = (values: string[]) => new Set(values).size === values.length;
const width = serverIconLabelUnits;

describe('server icon labels', () => {
  it('gives the brief\'s colliding names distinct, readable labels', () => {
    const names = ['vm-124', 'vm-125', 'vm-126', 'mini-2', 'pro.koca.win', '山东老孙', '投屏电视'];
    expect(texts(names)).toEqual(['VM/124', 'VM/125', 'VM/126', 'MINI/2', 'PRO/WIN', '山东/老孙', '投屏/电视']);
  });

  it('shows more than one character even for a lone server', () => {
    expect(texts(['Prod'])).toEqual(['PROD']);
    expect(texts(['kubernetes'])).toEqual(['KUBER/NETES']);
  });

  it('keeps the end of a trailing number, which is what tells machines apart', () => {
    expect(texts(['server-12345678', 'server-12345679'])).toEqual(['SERVE/45678', 'SERVE/45679']);
  });

  it('moves only the colliding names to a longer form', () => {
    // "mac-mini-pro" and "mac-studio-pro" both start MAC and end PRO at the shortest form.
    const out = texts(['mac-mini-pro', 'mac-studio-pro', 'dev']);
    expect(unique(out)).toBe(true);
    expect(out[2]).toBe('DEV');
    expect(out[0]).not.toBe(out[1]);
  });

  it('is case- and separator-insensitive, and falls back to an index suffix for names that stay identical', () => {
    const out = texts(['vm-1', 'VM_1', 'vm.1']);
    expect(unique(out)).toBe(true);
    expect(out.every((label) => label.includes('#'))).toBe(true);
    const same = texts(['alpha', 'alpha', 'alpha']);
    expect(same).toEqual(['ALPHA/#1', 'ALPHA/#2', 'ALPHA/#3']);
    // Two-line labels keep the suffix inside the line width.
    const long = buildServerIconLabels(['abcdefghij-klmnopqrst', 'abcdefghij-klmnopqrst']);
    for (const label of long) for (const line of label.lines) expect(width(line)).toBeLessThanOrEqual(SERVER_ICON_LABEL_LINE_UNITS);
    expect(unique(long.map((label) => label.lines.join('/')))).toBe(true);
  });

  it('counts CJK and emoji as wide characters and never splits them', () => {
    const cjk = buildServerIconLabels(['山东老孙科技有限公司', '山东老孙科技服务公司']);
    for (const label of cjk) for (const line of label.lines) expect(width(line)).toBeLessThanOrEqual(SERVER_ICON_LABEL_LINE_UNITS);
    expect(unique(cjk.map((label) => label.lines.join('/')))).toBe(true);
    const emoji = ['🚀rocket', '👨‍👩‍👧‍👦family', '🇨🇳china', 'é-lab', 'é-lab'];
    for (const label of buildServerIconLabels(emoji)) {
      for (const line of label.lines) {
        // Re-splitting a line gives the same text: no half of a surrogate pair, flag, ZWJ sequence or accent is left over.
        expect(splitServerIconGraphemes(line).join('')).toBe(line);
        expect(line).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|‍$/u);
      }
    }
    expect(buildServerIconLabels(['👨‍👩‍👧‍👦'])[0]!.lines).toEqual(['👨‍👩‍👧‍👦']);
    // Three flags are three characters of two units each: two on the first line, one on the second.
    expect(buildServerIconLabels(['🇨🇳🇯🇵🇰🇷'])[0]!.lines).toEqual(['🇨🇳🇯🇵', '🇰🇷']);
    expect(splitServerIconGraphemes('éx')).toEqual(['é', 'x']);
  });

  it('counts broad capitals as more than one unit so a line of W or M still fits the rail', () => {
    const [label] = buildServerIconLabels(['WWWWW-MMMMM']);
    expect(label!.lines).toEqual(['WWW', 'MMM']);
    for (const line of label!.lines) expect(width(line)).toBeLessThanOrEqual(SERVER_ICON_LABEL_LINE_UNITS);
    expect(buildServerIconLabels(['ЖЖЖЖЖ-ЩЩЩЩЩ'])[0]!.lines).toEqual(['ЖЖЖ', 'ЩЩЩ']);
    expect(serverIconLabelUnits('MINI')).toBe(4.5);
  });

  it('handles empty, blank, control-only and non-string names', () => {
    expect(texts(['', '   ', '\u0000​'])).toEqual([`${SERVER_ICON_LABEL_EMPTY}/#1`, `${SERVER_ICON_LABEL_EMPTY}/#2`, `${SERVER_ICON_LABEL_EMPTY}/#3`]);
    expect(texts([''])).toEqual([SERVER_ICON_LABEL_EMPTY]);
    expect(texts([undefined as unknown as string])).toEqual([SERVER_ICON_LABEL_EMPTY]);
    expect(buildServerIconLabels([])).toEqual([]);
  });

  it('keeps very long names to two short lines', () => {
    const name = `${'w'.repeat(5000)}-${'z'.repeat(5000)}`;
    const [label] = buildServerIconLabels([name]);
    expect(label!.lines.length).toBeLessThanOrEqual(2);
    for (const line of label!.lines) expect(width(line)).toBeLessThanOrEqual(SERVER_ICON_LABEL_LINE_UNITS);
    // Wide names too.
    const [wide] = buildServerIconLabels(['老'.repeat(5000)]);
    for (const line of wide!.lines) expect(width(line)).toBeLessThanOrEqual(SERVER_ICON_LABEL_LINE_UNITS);
  });

  it('keeps 50 servers (many collisions) unique, fast and stable in order', () => {
    const names = Array.from({ length: 50 }, (_, i) => (i % 5 === 0 ? 'vm-1' : i % 5 === 1 ? 'vm-2' : `vm-${100 + i}`));
    const started = Date.now();
    const labels = buildServerIconLabels(names);
    expect(Date.now() - started).toBeLessThan(500);
    expect(labels).toHaveLength(50);
    expect(unique(labels.map((label) => label.lines.join('/')))).toBe(true);
    // Deterministic: the same list gives the same labels.
    expect(buildServerIconLabels(names)).toEqual(labels);
    const mixed = Array.from({ length: 50 }, (_, i) => ['prod', 'stage', '山东', 'mac-mini', 'mac-pro'][i % 5] + (i < 25 ? '' : `-${i}`));
    expect(unique(texts(mixed))).toBe(true);
  });

  it('a rename changes only what it must', () => {
    const before = texts(['vm-124', 'vm-125', 'dev']);
    const after = texts(['vm-124', 'vm-125', 'dev-box']);
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
    expect(after[2]).toBe('DEV/BOX');
  });

  it('picks a font size from the label: short single lines are large, long or two-line labels small', () => {
    const size = (name: string) => buildServerIconLabels([name])[0]!.size;
    expect(size('a')).toBe(SERVER_ICON_LABEL_SIZES.LARGE);
    expect(size('山')).toBe(SERVER_ICON_LABEL_SIZES.LARGE);
    expect(size('abc')).toBe(SERVER_ICON_LABEL_SIZES.MEDIUM);
    expect(size('abcde')).toBe(SERVER_ICON_LABEL_SIZES.SMALL);
    expect(size('vm-124')).toBe(SERVER_ICON_LABEL_SIZES.SMALL);
  });
});
