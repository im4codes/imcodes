import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContextNamespace } from '../../shared/context-types.js';
import { queryProcessedProjections, writeProcessedProjection } from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

describe('processed projection redaction boundary', () => {
  let tempDir: string;
  let oldCwd: string;
  const namespace: ContextNamespace = { scope: 'personal', projectId: 'repo', userId: 'user-1' };

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('redaction-single-pass');
    oldCwd = process.cwd();
    await mkdir(join(tempDir, '.imc'), { recursive: true });
    await writeFile(join(tempDir, '.imc', 'memory.yaml'), 'redactPatterns:\n  - KEEP_ME_VISIBLE\n', 'utf8');
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(oldCwd);
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('persists caller-produced summaries without a second process-cwd redaction pass', () => {
    const projection = writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-1'],
      summary: 'KEEP_ME_VISIBLE [REDACTED:bearer]',
      content: { note: 'KEEP_ME_VISIBLE' },
      createdAt: 1,
      updatedAt: 1,
    });

    expect(projection.summary).toBe('KEEP_ME_VISIBLE [REDACTED:bearer]');
    expect(projection.content).toEqual({ note: 'KEEP_ME_VISIBLE' });

    const [stored] = queryProcessedProjections({ projectId: namespace.projectId, limit: 1 });
    expect(stored?.summary).toBe('KEEP_ME_VISIBLE [REDACTED:bearer]');
    expect(stored?.content).toEqual({ note: 'KEEP_ME_VISIBLE' });
  });
});
