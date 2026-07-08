import { describe, expect, it, vi } from 'vitest';

vi.mock('@qoder-ai/qoder-agent-sdk', () => {
  throw new Error('mock missing qoder sdk');
});

vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { QoderSdkProvider } from '../../src/agent/providers/qoder-sdk.js';
import { PROVIDER_ERROR_CODES } from '../../src/agent/transport-provider.js';
import { QODER_READINESS_REASON } from '../../src/agent/qoder-sdk-config.js';

describe('Qoder SDK import failure', () => {
  it('connects degraded and fails sends with structured CONFIG_ERROR', async () => {
    const provider = new QoderSdkProvider();
    await provider.connect({});
    const route = await provider.createSession({
      sessionKey: 'route-import-failure',
      sessionName: 'deck_alpha_worker',
      projectName: 'alpha',
      serverId: 'srv-bound',
      cwd: '/tmp/project',
      env: { QODER_PERSONAL_ACCESS_TOKEN: 'pat_test_secret' },
    });

    expect(provider.getSessionDiagnostics(route)).toMatchObject({
      readiness: {
        runtimeReady: 'missing',
        sendReady: 'degraded',
      },
    });
    await expect(provider.send(route, 'hello')).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.CONFIG_ERROR,
      details: { reason: QODER_READINESS_REASON.SUPPLY_CHAIN_PRECHECK_FAILED },
    });

    await provider.disconnect();
  });
});
