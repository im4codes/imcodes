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

function makeTrackedConnection(
  implementation: (request: any) => Promise<{ stopReason: 'end_turn' | 'cancelled' }>,
) {
  const tracker = {
    writeQueue: Promise.resolve(),
    nextWrite: null as Promise<void> | null,
    abortController: new AbortController(),
  };
  const prompt = vi.fn((request: any) => {
    tracker.writeQueue = tracker.nextWrite ?? Promise.resolve();
    tracker.nextWrite = null;
    return implementation(request);
  });
  return {
    prompt,
    tracker,
    connection: { prompt, connection: tracker },
  };
}

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
    const tracked = makeTrackedConnection(async () => ({ stopReason: 'end_turn' }));
    const { prompt } = tracked;
    const internal = provider as unknown as {
      connection: typeof tracked.connection;
      sessions: Map<string, Record<string, unknown>>;
    };
    internal.connection = tracked.connection;
    internal.sessions.set('route-next', {
      routeId: 'route-next',
      cwd: '/tmp',
      loaded: true,
      promptInFlight: true,
      turnGeneration: 1,
      promptSubmittedGeneration: 1,
      activePromptAdmissions: new Map(),
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

    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'acp-next',
      prompt: [{ type: 'text', text: 'insert at the next safe boundary' }],
      messageId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    }));
    await expect(provider.notifyActiveDelegation('route-next', {
      notificationId: 'append-next',
      delegationId: 'queue-append:append-next',
      sourceSessionName: 'deck_codebuddy_brain',
      text: 'insert at the next safe boundary',
      deliveryKind: 'queued_message',
    })).resolves.toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it('does not acknowledge an ACP prompt whose serialized writable fails', async () => {
    const provider = new CodeBuddyChinaProvider();
    const tracked = makeTrackedConnection(() => new Promise(() => {}));
    let releaseWrite!: () => void;
    tracked.tracker.nextWrite = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const internal = provider as unknown as {
      connection: typeof tracked.connection;
      sessions: Map<string, Record<string, unknown>>;
    };
    internal.connection = tracked.connection;
    internal.sessions.set('route-write-failure', {
      routeId: 'route-write-failure',
      cwd: '/tmp',
      loaded: true,
      promptInFlight: true,
      turnGeneration: 2,
      promptSubmittedGeneration: 2,
      activePromptAdmissions: new Map(),
      cancelled: false,
      acpSessionId: 'acp-write-failure',
    });

    const admission = provider.notifyActiveDelegation('route-write-failure', {
      notificationId: 'append-write-failure',
      delegationId: 'queue-append:append-write-failure',
      sourceSessionName: 'deck_codebuddy_brain',
      text: 'must remain durable',
      deliveryKind: 'queued_message',
    });
    await vi.waitFor(() => expect(tracked.prompt).toHaveBeenCalledOnce());
    tracked.tracker.abortController.abort(new Error('ACP writable failed'));
    releaseWrite();

    await expect(admission).resolves.toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.STALE);
    expect((internal.sessions.get('route-write-failure')!.activePromptAdmissions as Map<string, unknown>).size).toBe(0);
  });

  it('retains one admission authority after the original turn settles until its write is terminal', async () => {
    const provider = new CodeBuddyChinaProvider();
    const tracked = makeTrackedConnection(() => new Promise(() => {}));
    let releaseWrite!: () => void;
    tracked.tracker.nextWrite = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const internal = provider as unknown as {
      connection: typeof tracked.connection;
      sessions: Map<string, Record<string, any>>;
    };
    internal.connection = tracked.connection;
    internal.sessions.set('route-late-write', {
      routeId: 'route-late-write',
      cwd: '/tmp',
      loaded: true,
      promptInFlight: true,
      turnGeneration: 3,
      promptSubmittedGeneration: 3,
      activePromptAdmissions: new Map(),
      cancelled: false,
      acpSessionId: 'acp-late-write',
    });
    const notification = {
      notificationId: 'append-late-write',
      delegationId: 'queue-append:append-late-write',
      sourceSessionName: 'deck_codebuddy_brain',
      text: 'deliver exactly once',
      deliveryKind: 'queued_message' as const,
    };

    const first = provider.notifyActiveDelegation('route-late-write', notification);
    await vi.waitFor(() => expect(tracked.prompt).toHaveBeenCalledOnce());
    const state = internal.sessions.get('route-late-write')!;
    state.promptInFlight = false;
    state.promptSubmittedGeneration = null;
    state.cancelled = true;
    const retry = provider.notifyActiveDelegation('route-late-write', notification);

    expect(tracked.prompt).toHaveBeenCalledOnce();
    releaseWrite();
    await expect(Promise.all([first, retry])).resolves.toEqual([
      AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED,
      AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED,
    ]);
    expect(tracked.prompt).toHaveBeenCalledOnce();
  });

  it.each([
    ['China', () => new CodeBuddyChinaProvider()],
    ['International', () => new CodeBuddyInternationalProvider()],
  ])('submits consecutive %s appends in order without awaiting their long-lived turn responses', async (_region, makeProvider) => {
    const provider = makeProvider();
    const pending: Array<() => void> = [];
    const tracked = makeTrackedConnection(() => new Promise<{ stopReason: 'end_turn' }>((resolve) => {
      pending.push(() => resolve({ stopReason: 'end_turn' }));
    }));
    const { prompt } = tracked;
    const internal = provider as unknown as {
      connection: typeof tracked.connection;
      sessions: Map<string, Record<string, unknown>>;
    };
    internal.connection = tracked.connection;
    internal.sessions.set('route-next', {
      routeId: 'route-next',
      cwd: '/tmp',
      loaded: true,
      promptInFlight: true,
      turnGeneration: 7,
      promptSubmittedGeneration: 7,
      activePromptAdmissions: new Map(),
      cancelled: false,
      acpSessionId: 'acp-next',
    });

    const first = provider.notifyActiveDelegation('route-next', {
      notificationId: 'append-B',
      delegationId: 'queue-append:append-B',
      sourceSessionName: 'deck_codebuddy_brain',
      text: 'B',
      deliveryKind: 'queued_message',
    });
    const second = provider.notifyActiveDelegation('route-next', {
      notificationId: 'append-C',
      delegationId: 'queue-append:append-C',
      sourceSessionName: 'deck_codebuddy_brain',
      text: 'C',
      deliveryKind: 'queued_message',
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED,
      AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED,
    ]);
    expect(prompt.mock.calls.map((call) => call[0].prompt[0]?.text)).toEqual(['B', 'C']);
    expect(pending).toHaveLength(2);
    pending.forEach((resolve) => resolve());
  });

  it('does not append before the original CodeBuddy prompt generation is submitted', async () => {
    const provider = new CodeBuddyChinaProvider();
    const tracked = makeTrackedConnection(async () => ({ stopReason: 'end_turn' }));
    const { prompt } = tracked;
    const internal = provider as unknown as {
      connection: typeof tracked.connection;
      sessions: Map<string, Record<string, unknown>>;
    };
    internal.connection = tracked.connection;
    internal.sessions.set('route-starting', {
      routeId: 'route-starting',
      cwd: '/tmp',
      loaded: true,
      promptInFlight: true,
      turnGeneration: 8,
      promptSubmittedGeneration: null,
      activePromptAdmissions: new Map(),
      cancelled: false,
      acpSessionId: 'acp-starting',
    });

    await expect(provider.notifyActiveDelegation('route-starting', {
      notificationId: 'append-too-early',
      delegationId: 'queue-append:append-too-early',
      sourceSessionName: 'deck_codebuddy_brain',
      text: 'must wait for A',
      deliveryKind: 'queued_message',
    })).resolves.toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.STALE);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('resolves send-start only after submitting A, while A/B/C turn responses remain long-lived', async () => {
    const provider = new CodeBuddyChinaProvider();
    const pending: Array<() => void> = [];
    const tracked = makeTrackedConnection(() => new Promise<{ stopReason: 'end_turn' }>((resolve) => {
      pending.push(() => resolve({ stopReason: 'end_turn' }));
    }));
    const { prompt } = tracked;
    const internal = provider as unknown as {
      config: Record<string, unknown> | null;
      initPromise: Promise<void> | null;
      connection: typeof tracked.connection;
      sessions: Map<string, Record<string, unknown>>;
    };
    internal.config = {};
    internal.initPromise = Promise.resolve();
    internal.connection = tracked.connection;
    await provider.createSession({ sessionKey: 'route-admission', cwd: '/tmp', resumeId: 'acp-admission' });
    const state = internal.sessions.get('route-admission')!;
    state.loaded = true;
    state.modeApplied = true;

    await expect(provider.send('route-admission', 'A')).resolves.toBeUndefined();
    expect(prompt.mock.calls.map((call) => call[0].prompt[0]?.text)).toEqual(['A']);
    expect(state.promptSubmittedGeneration).toBe(state.turnGeneration);

    await expect(provider.notifyActiveDelegation('route-admission', {
      notificationId: 'append-B',
      delegationId: 'queue-append:append-B',
      sourceSessionName: 'deck_codebuddy_brain',
      text: 'B',
      deliveryKind: 'queued_message',
    })).resolves.toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED);
    await expect(provider.notifyActiveDelegation('route-admission', {
      notificationId: 'append-C',
      delegationId: 'queue-append:append-C',
      sourceSessionName: 'deck_codebuddy_brain',
      text: 'C',
      deliveryKind: 'queued_message',
    })).resolves.toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED);
    expect(prompt.mock.calls.map((call) => call[0].prompt[0]?.text)).toEqual(['A', 'B', 'C']);
    expect(pending).toHaveLength(3);
    pending.forEach((resolve) => resolve());
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
