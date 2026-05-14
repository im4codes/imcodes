import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionMock, listSessionsMock, timelineEmitMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  listSessionsMock: vi.fn(),
  timelineEmitMock: vi.fn(),
}));

vi.mock('../../src/store/session-store.js', () => ({
  getSession: (...args: unknown[]) => getSessionMock(...args),
  listSessions: (...args: unknown[]) => listSessionsMock(...args),
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: {
    emit: (...args: unknown[]) => timelineEmitMock(...args),
  },
}));

function inbound(content: string, overrides: Partial<import('../../src/router/message-router.js').InboundMessage> = {}) {
  return {
    platform: 'slack',
    botId: 'bot-1',
    channelId: 'C1',
    userId: 'user-1',
    content,
    isCommand: false,
    raw: {},
    ...overrides,
  };
}

function context() {
  return {
    sendOutbound: vi.fn(async () => undefined),
    sendToSession: vi.fn(async () => undefined),
    persistBinding: vi.fn(async () => true),
    removeBinding: vi.fn(async () => true),
  };
}

describe('message router contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listSessionsMock.mockReturnValue([
      { name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain', state: 'running', agentType: 'codex-sdk' },
      { name: 'deck_alpha_worker', projectName: 'alpha', role: 'worker', state: 'idle', agentType: 'gemini' },
      { name: 'deck_beta_brain', projectName: 'beta', role: 'brain', state: 'idle', agentType: 'codex-sdk' },
    ]);
    getSessionMock.mockReturnValue({ name: 'deck_alpha_brain' });
  });

  afterEach(async () => {
    const router = await import('../../src/router/message-router.js');
    for (const binding of router.getAllBindings()) {
      router.unbindChannel(binding.platform, binding.channelId, binding.botId);
    }
  });

  it('binds, persists, rolls back failed persistence, and enforces binding access', async () => {
    const router = await import('../../src/router/message-router.js');
    const ctx = context();

    await router.routeMessage(inbound('/bind'), ctx);
    expect(ctx.sendOutbound).toHaveBeenLastCalledWith('C1', 'slack', 'bot-1', 'Usage: /bind <project-name>');

    await router.routeMessage(inbound('/bind missing'), ctx);
    expect(ctx.sendOutbound.mock.calls.at(-1)?.[3]).toContain('no active brain session');

    ctx.persistBinding.mockResolvedValueOnce(false);
    await router.routeMessage(inbound('/bind alpha'), ctx);
    expect(router.getBinding('slack', 'C1', 'bot-1')).toBeUndefined();
    expect(ctx.sendOutbound.mock.calls.at(-1)?.[3]).toContain('Failed to bind channel');

    await router.routeMessage(inbound('/bind alpha'), ctx);
    expect(router.getBinding('slack', 'C1', 'bot-1')).toMatchObject({ projectName: 'alpha', boundBy: 'user-1' });

    router.bindChannel('slack', 'private', 'bot-1', 'alpha', 'owner', { allowedUserIds: ['owner'] });
    await router.routeMessage(inbound('hello', { channelId: 'private', userId: 'intruder' }), ctx);
    expect(ctx.sendToSession).not.toHaveBeenCalledWith('deck_alpha_brain', 'hello');

    await router.routeMessage(inbound('/status', { platform: 'discord', channelId: 'unbound' }), ctx);
    expect(ctx.sendOutbound.mock.calls.at(-1)?.[3]).toContain('not bound');
  });

  it('routes project commands and text to the bound brain session', async () => {
    const router = await import('../../src/router/message-router.js');
    const ctx = context();
    router.bindChannel('slack', 'C1', 'bot-1', 'alpha', 'user-1');

    await router.routeMessage(inbound('/status'), ctx);
    expect(ctx.sendOutbound.mock.calls.at(-1)?.[3]).toContain('deck_alpha_brain: running');

    await router.routeMessage(inbound('/list'), ctx);
    expect(ctx.sendOutbound.mock.calls.at(-1)?.[3]).toContain('alpha/brain [running]');

    await router.routeMessage(inbound('/stop'), ctx);
    expect(ctx.sendToSession).toHaveBeenCalledWith('deck_alpha_brain', '@stop');

    await router.routeMessage(inbound('/screen worker'), ctx);
    expect(getSessionMock).toHaveBeenCalledWith('deck_alpha_worker');
    expect(ctx.sendToSession).toHaveBeenCalledWith('deck_alpha_brain', '@screen deck_alpha_worker');

    getSessionMock.mockReturnValueOnce(null);
    await router.routeMessage(inbound('/screen ghost'), ctx);
    expect(ctx.sendOutbound.mock.calls.at(-1)?.[3]).toContain('not found');

    await router.routeMessage(inbound('/send please review'), ctx);
    expect(ctx.sendToSession).toHaveBeenCalledWith('deck_alpha_brain', 'please review');
    expect(timelineEmitMock).toHaveBeenCalledWith('deck_alpha_brain', 'user.message', { text: 'please review' });

    await router.routeMessage(inbound('plain text'), ctx);
    expect(ctx.sendToSession).toHaveBeenCalledWith('deck_alpha_brain', 'plain text');

    await router.routeMessage(inbound('/unknown raw args'), ctx);
    expect(ctx.sendToSession).toHaveBeenCalledWith('deck_alpha_brain', '/unknown raw args');
  });

  it('handles help and team command branches', async () => {
    const router = await import('../../src/router/message-router.js');
    const ctx = context();
    router.bindChannel('slack', 'C1', 'bot-1', 'alpha', 'user-1');

    await router.routeMessage(inbound('/help'), ctx);
    expect(ctx.sendOutbound.mock.calls.at(-1)?.[3]).toContain('Available commands');

    await router.routeMessage(inbound('/team help'), ctx);
    expect(ctx.sendOutbound.mock.calls.at(-1)?.[3]).toContain('Team commands');

    await router.routeMessage(inbound('/team invite'), ctx);
    expect(ctx.sendToSession).toHaveBeenCalledWith('deck_alpha_brain', '/team invite');
    expect(ctx.sendOutbound.mock.calls.at(-1)?.[3]).toContain('Team command forwarded');

    await router.routeMessage(inbound('/help', { isCommand: true, command: 'help', args: [] }), ctx);
    expect(ctx.sendOutbound.mock.calls.at(-1)?.[3]).toContain('Available commands');
  });
});
