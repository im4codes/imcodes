import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES,
  AGENT_DELEGATION_NOTIFICATION_RESULTS,
} from '../../shared/agent-delegation.js';
import {
  CODEBUDDY_CHINA_DEFAULT_MODEL,
  CODEBUDDY_ENVIRONMENT_VARIABLE,
  CODEBUDDY_PROVIDER_IDS,
  CODEBUDDY_REGIONS,
} from '../../shared/codebuddy.js';
import {
  CodeBuddyChinaProvider,
  CodeBuddyInternationalProvider,
  resolveCodeBuddyBinaryPath,
} from '../../src/agent/providers/codebuddy.js';
import { KimiSdkProvider } from '../../src/agent/providers/kimi-sdk.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CodeBuddy ACP providers', () => {
  it('exposes China and International as independent streaming providers', () => {
    const china = new CodeBuddyChinaProvider();
    const international = new CodeBuddyInternationalProvider();

    expect(china.id).toBe(CODEBUDDY_PROVIDER_IDS.CHINA);
    expect(international.id).toBe(CODEBUDDY_PROVIDER_IDS.INTERNATIONAL);
    for (const provider of [china, international]) {
      expect(provider.capabilities).toMatchObject({
        streaming: true,
        toolCalling: true,
        approval: true,
        sessionRestore: true,
        multiTurn: true,
        activeDelegationNotification: AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES.NATIVE,
      });
    }
  });

  it('admits appended messages through CodeBuddy busy-prompt queue without cancellation', async () => {
    const provider = new CodeBuddyChinaProvider();
    const prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
    const internal = provider as unknown as {
      connection: { prompt: typeof prompt };
      sessions: Map<string, Record<string, unknown>>;
    };
    internal.connection = { prompt };
    internal.sessions.set('route-next', {
      routeId: 'route-next',
      cwd: '/tmp',
      loaded: true,
      promptInFlight: true,
      cancelled: false,
      acpSessionId: 'acp-next',
    });

    await expect(provider.notifyActiveDelegation('route-next', {
      notificationId: 'append-next',
      delegationId: 'queue-append:append-next',
      sourceSessionName: 'deck_codebuddy_brain',
      text: 'insert at the next safe boundary',
      deliveryKind: 'queued_message',
    })).resolves.toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED);

    expect(prompt).toHaveBeenCalledWith({
      sessionId: 'acp-next',
      prompt: [{ type: 'text', text: 'insert at the next safe boundary' }],
    });
  });

  it('fails closed when there is no active CodeBuddy turn to receive an append', async () => {
    const provider = new CodeBuddyChinaProvider();
    await expect(provider.notifyActiveDelegation('missing', {
      notificationId: 'append-stale',
      delegationId: 'queue-append:append-stale',
      sourceSessionName: 'deck_codebuddy_brain',
      text: 'do not start a surprise turn',
      deliveryKind: 'queued_message',
    })).resolves.toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.STALE);
  });

  it('pins the China environment and keeps caller environment values', async () => {
    const connect = vi.spyOn(KimiSdkProvider.prototype, 'connect').mockResolvedValue();
    const provider = new CodeBuddyChinaProvider();

    await provider.connect({
      binaryPath: '/opt/codebuddy-cn',
      env: {
        TEST_ONLY: 'kept',
        [CODEBUDDY_ENVIRONMENT_VARIABLE]: CODEBUDDY_REGIONS.INTERNATIONAL,
        CODEBUDDY_CODE_MESSAGE_QUEUE_DEFERRED_DISPATCH: 'true',
      },
    });

    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      binaryPath: '/opt/codebuddy-cn',
      env: {
        TEST_ONLY: 'kept',
        [CODEBUDDY_ENVIRONMENT_VARIABLE]: CODEBUDDY_REGIONS.CHINA,
        CODEBUDDY_CODE_MESSAGE_QUEUE_DEFERRED_DISPATCH: 'false',
      },
    }));
  });

  it('pins the International environment independently', async () => {
    const connect = vi.spyOn(KimiSdkProvider.prototype, 'connect').mockResolvedValue();
    const provider = new CodeBuddyInternationalProvider();

    await provider.connect({ binaryPath: '/opt/codebuddy-global' });

    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      binaryPath: '/opt/codebuddy-global',
      env: {
        [CODEBUDDY_ENVIRONMENT_VARIABLE]: CODEBUDDY_REGIONS.INTERNATIONAL,
        CODEBUDDY_CODE_MESSAGE_QUEUE_DEFERRED_DISPATCH: 'false',
      },
    }));
  });

  it('defaults only China sessions to the limited-time-free Hy3 model', async () => {
    const createSession = vi.spyOn(KimiSdkProvider.prototype, 'createSession')
      .mockResolvedValue('route');

    await new CodeBuddyChinaProvider().createSession({ sessionKey: 'cn', cwd: '/tmp' });
    expect(createSession).toHaveBeenLastCalledWith(expect.objectContaining({
      agentId: CODEBUDDY_CHINA_DEFAULT_MODEL,
    }));

    await new CodeBuddyChinaProvider().createSession({ sessionKey: 'cn-model', cwd: '/tmp', agentId: 'glm-5.2' });
    expect(createSession).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: 'glm-5.2' }));

    await new CodeBuddyInternationalProvider().createSession({ sessionKey: 'global', cwd: '/tmp' });
    expect(createSession.mock.calls.at(-1)?.[0].agentId).toBeUndefined();
  });

  it('honors an explicit binary path before any platform discovery', () => {
    expect(resolveCodeBuddyBinaryPath(CODEBUDDY_REGIONS.CHINA, { binaryPath: '/custom/codebuddy' }))
      .toBe('/custom/codebuddy');
    expect(resolveCodeBuddyBinaryPath(CODEBUDDY_REGIONS.INTERNATIONAL, { binaryPath: '/custom/codebuddy-global' }))
      .toBe('/custom/codebuddy-global');
  });
});
