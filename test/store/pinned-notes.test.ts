import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextNamespace, ContextTargetRef } from '../../shared/context-types.js';
import { serializeContextNamespace } from '../../src/context/context-keys.js';
import { MaterializationCoordinator } from '../../src/context/materialization-coordinator.js';
import { localOnlyCompressor } from '../../src/context/summary-compressor.js';
import { addPinnedNote, resetContextStoreForTests } from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

describe('pinned notes store integration', () => {
  let tempDir: string;
  let namespace: ContextNamespace;
  let target: ContextTargetRef;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('pinned-notes');
    namespace = { scope: 'personal', projectId: 'repo', userId: 'user-1' };
    target = { namespace, kind: 'session', sessionName: 'deck_repo_brain' };
  });

  afterEach(async () => {
    resetContextStoreForTests();
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('injects pinned notes byte-identically under the User-Pinned Notes heading', async () => {
    const pinned = 'password: required\nhex-looking value: 0123456789abcdef0123456789abcdef01234567\n空白  그대로';
    addPinnedNote({ namespaceKey: serializeContextNamespace(namespace), content: pinned, id: 'pin-1', now: 100 });

    const coordinator = new MaterializationCoordinator({
      compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });
    coordinator.ingestEvent({ id: 'evt-pinned', target, eventType: 'assistant.text', content: 'completed the requested change', createdAt: 110 });
    const result = await coordinator.materializeTarget(target, 'manual', 200);

    expect(result.summaryProjection?.summary).toContain(`## User-Pinned Notes\n${pinned}\n\n`);
  });
});
