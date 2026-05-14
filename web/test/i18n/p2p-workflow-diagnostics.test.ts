import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { P2P_WORKFLOW_DIAGNOSTIC_CODES } from '../../../shared/p2p-workflow-diagnostics.js';
import { SUPPORTED_LOCALES } from '../../src/i18n/locales/index.js';

const WEB_ROOT = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');

function getPath(value: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((current, part) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[part];
  }, value);
}

describe('P2P workflow diagnostics i18n', () => {
  it('defines every shared diagnostic code in every supported locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(
        readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8'),
      ) as Record<string, unknown>;
      for (const code of P2P_WORKFLOW_DIAGNOSTIC_CODES) {
        const key = `p2p.workflow.diagnostics.${code}`;
        const value = getPath(messages, key);
        expect(value, `${locale}:${key}`).toEqual(expect.any(String));
        expect((value as string).trim().length, `${locale}:${key}`).toBeGreaterThan(0);
      }
    }
  });
});
