import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { redactSensitiveText } from '../../src/util/redact-secrets.js';

// Each positive's `parts` is joined at test time; the fixture stores secrets
// as fragments so GitHub secret-scanning never sees a literal secret-shaped
// string in the file. The redactor regex matches the joined string the same
// way it would match a literal — coverage is unchanged.
interface Corpus {
  positives: Array<{ type: string; parts: string[] }>;
  guards: string[];
}

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'redact-corpus.json'), 'utf8')) as Corpus;

describe('redactSensitiveText', () => {
  it('redacts every provider secret in the JSON corpus with typed tags', () => {
    expect(corpus.positives.length).toBeGreaterThanOrEqual(30);
    for (const item of corpus.positives) {
      const sample = item.parts.join('');
      expect(redactSensitiveText(sample), sample).toContain(`[REDACTED:${item.type}]`);
    }
  });

  it('keeps common harmless strings from the JSON corpus', () => {
    expect(corpus.guards.length).toBeGreaterThanOrEqual(15);
    for (const input of corpus.guards) {
      expect(redactSensitiveText(input), input).toBe(input);
    }
  });

  it('supports project-local custom pattern extensions', () => {
    expect(redactSensitiveText('custom-secret-123', [/custom-secret-\d+/g])).toBe('[REDACTED:custom]');
  });
});
