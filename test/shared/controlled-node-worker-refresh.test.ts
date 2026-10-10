import { describe, expect, it } from 'vitest';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import {
  CONTROLLED_NODE_WORKER_REFRESH_PHASE,
  validateControlledNodeWorkerRefreshStatusMessage,
} from '../../shared/controlled-node-worker-refresh.js';

describe('controlled worker refresh status wire contract', () => {
  it('accepts bounded success metadata for UI projection', () => {
    const result = validateControlledNodeWorkerRefreshStatusMessage({
      type: DAEMON_MSG.CONTROLLED_NODE_WORKER_REFRESH_STATUS,
      attemptId: 'attempt-1234',
      phase: CONTROLLED_NODE_WORKER_REFRESH_PHASE.SUCCEEDED,
      installedVersion: '2026.10.1-dev.2',
      targetVersion: '2026.10.1-dev.2',
      artifactSha256: 'a'.repeat(64),
      recordedAt: 123,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects unknown fields and invalid hashes instead of exposing untrusted state', () => {
    expect(validateControlledNodeWorkerRefreshStatusMessage({
      type: DAEMON_MSG.CONTROLLED_NODE_WORKER_REFRESH_STATUS,
      attemptId: 'attempt-1234',
      phase: CONTROLLED_NODE_WORKER_REFRESH_PHASE.FAILED,
      artifactSha256: 'not-a-hash',
      recordedAt: 123,
      secret: 'must-not-pass',
    }).ok).toBe(false);
  });
});
