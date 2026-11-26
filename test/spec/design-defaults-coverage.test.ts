import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { MEMORY_DEFAULTS } from '../../shared/memory-defaults.js';
import { readSource } from '../helpers/read-source.js';

const DESIGN_PATH = 'openspec/changes/memory-system-post-1-1-integration/design.md';

function readDesignDefaults(): Record<string, number> {
  const design = readSource(DESIGN_PATH);
  const match = design.match(/```json5\n\/\/ design-defaults\n(?<body>\{[\s\S]*?\})\n```/);
  if (!match?.groups?.body) throw new Error('design-defaults JSON5 block not found');
  const entries = [...match.groups.body.matchAll(/^\s*(?<key>[A-Za-z][A-Za-z0-9]*):\s*(?<value>\d+),?\s*$/gm)];
  return Object.fromEntries(entries.map((entry) => [entry.groups?.key ?? '', Number(entry.groups?.value)]));
}

describe.skipIf(!existsSync(DESIGN_PATH))('design defaults coverage', () => {
  it('keeps shared memory defaults in sync with the OpenSpec design-defaults block', () => {
    expect(MEMORY_DEFAULTS).toEqual(readDesignDefaults());
  });
});
