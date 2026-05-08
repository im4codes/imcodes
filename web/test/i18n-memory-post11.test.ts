import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from '../src/i18n/locales/index.js';

const WEB_ROOT = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');

const REQUIRED_KEYS = [
  'memory.quickSearch.disabled',
  'memory.quickSearch.noResults',
  'memory.quickSearch.citationUnavailable',
  'memory.skills.disabled',
  'memory.skills.loadFailed',
  'memory.skills.renderDropped',
  'memory.skills.layerDiagnostics',
  'memory.skills.enforced',
  'memory.skills.additive',
  'sharedContext.notice.memoryCreated',
  'sharedContext.notice.memoryUpdated',
  'sharedContext.notice.memoryPinned',
  'sharedContext.management.memoryManualAddTitle',
  'sharedContext.management.memoryManualAddSave',
  'sharedContext.management.memoryPin',
  'sharedContext.management.memoryUpdate',
  'sharedContext.management.memoryRecordOwner',
  'sharedContext.management.memoryRecordCreatedBy',
  'sharedContext.management.memoryRecordUpdatedBy',
  'sharedContext.management.memoryPreferenceUpdate',
  'sharedContext.management.memoryObservationUpdate',
  'sharedContext.management.memoryObservationDeleteConfirm',
  'sharedContext.management.error.missing_memory_text',
  'sharedContext.management.error.memory_not_found',
  'sharedContext.management.error.missing_observation_text',
  'sharedContext.management.error.observation_mutation_forbidden',
] as const;

function getPath(value: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((current, part) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[part];
  }, value);
}

describe('post-1.1 memory i18n coverage', () => {
  it('defines quick-search/citation/skill strings for every supported locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const raw = readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8');
      const messages = JSON.parse(raw) as Record<string, unknown>;
      for (const key of REQUIRED_KEYS) {
        expect(getPath(messages, key), `${locale}:${key}`).toEqual(expect.any(String));
        expect((getPath(messages, key) as string).trim().length, `${locale}:${key}`).toBeGreaterThan(0);
      }
    }
  });
});
