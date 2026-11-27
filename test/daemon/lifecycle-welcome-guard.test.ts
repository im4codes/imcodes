import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as agentAvailability from '../../src/agent/agent-availability.js';
import * as providerRegistry from '../../src/agent/provider-registry.js';
import * as sessionManager from '../../src/agent/session-manager.js';
import {
  reconcileRuntimesAfterWorkerSessionSync,
  runWelcomeBootstrapNonBlocking,
} from '../../src/daemon/lifecycle.js';
import { WORKER_SESSION_SYNC_STATUS } from '../../shared/worker-session-snapshot.js';

let tempDir = '';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'imcodes-lifecycle-welcome-guard-'));
  vi.stubEnv('HOME', tempDir);
  vi.stubEnv('USERPROFILE', tempDir);
  vi.stubEnv('IMCODES_HOME', join(tempDir, '.imcodes'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
});

describe('lifecycle welcome bootstrap test-mode guard', () => {
  it('never probes installed agents, connects providers, or creates Welcome on startup or worker sync reconcile in Vitest', async () => {
    const detectSpy = vi.spyOn(agentAvailability, 'detectInstalledAgentsWithMetadata');
    const connectSpy = vi.spyOn(providerRegistry, 'ensureProviderConnected');
    const launchSpy = vi.spyOn(sessionManager, 'launchTransportSession');

    await runWelcomeBootstrapNonBlocking(null, false, null);
    await runWelcomeBootstrapNonBlocking(null, true, {
      status: WORKER_SESSION_SYNC_STATUS.APPLIED,
      remoteSessionCount: 0,
      remoteSubSessionCount: 0,
    });
    await reconcileRuntimesAfterWorkerSessionSync(null, {
      status: WORKER_SESSION_SYNC_STATUS.APPLIED,
      snapshotComplete: true,
      retryable: false,
      remoteSessionCount: 0,
      remoteSubSessionCount: 0,
      syncedCount: 0,
      pendingMissingCount: 0,
      issues: [],
      mainUpserts: [],
      remoteTestSessions: [],
      remoteTestSubSessions: [],
      remoteMainExistenceNames: [],
      remoteSubSessionNames: [],
      startupPushAllowedNames: [],
    });

    expect(detectSpy).not.toHaveBeenCalled();
    expect(connectSpy).not.toHaveBeenCalled();
    expect(launchSpy).not.toHaveBeenCalled();
  });
});
