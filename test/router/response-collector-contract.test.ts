import { beforeEach, describe, expect, it, vi } from 'vitest';

const { capturePaneMock, getAllBindingsMock } = vi.hoisted(() => ({
  capturePaneMock: vi.fn(),
  getAllBindingsMock: vi.fn(),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  capturePane: (...args: unknown[]) => capturePaneMock(...args),
}));

vi.mock('../../src/router/message-router.js', () => ({
  getAllBindings: (...args: unknown[]) => getAllBindingsMock(...args),
}));

async function loadCollector() {
  vi.resetModules();
  return import('../../src/router/response-collector.js');
}

describe('response collector contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturePaneMock.mockReset();
    getAllBindingsMock.mockReset();
    getAllBindingsMock.mockReturnValue([
      { platform: 'slack', botId: 'bot-1', channelId: 'C1', projectName: 'alpha' },
      { platform: 'discord', botId: 'bot-2', channelId: 'D1', projectName: 'alpha' },
      { platform: 'slack', botId: 'bot-3', channelId: 'C2', projectName: 'beta' },
    ]);
  });

  it('captures only changed screen content and can reset tracked state', async () => {
    const collector = await loadCollector();

    capturePaneMock.mockResolvedValueOnce(['one', 'two']);
    await expect(collector.captureAndDiff('deck_alpha')).resolves.toBe('one\ntwo');

    capturePaneMock.mockResolvedValueOnce(['one', 'two']);
    await expect(collector.captureAndDiff('deck_alpha')).resolves.toBeNull();

    capturePaneMock.mockResolvedValueOnce(['one', 'two', 'three']);
    await expect(collector.captureAndDiff('deck_alpha')).resolves.toBe('three');

    capturePaneMock.mockResolvedValueOnce(['fresh']);
    collector.clearScreenState('deck_alpha');
    await expect(collector.captureAndDiff('deck_alpha')).resolves.toBe('fresh');

    capturePaneMock.mockRejectedValueOnce(new Error('tmux unavailable'));
    await expect(collector.captureAndDiff('deck_alpha')).resolves.toBeNull();
  });

  it('cleans idle output and dispatches it to all project bindings', async () => {
    const collector = await loadCollector();
    const sendOutbound = vi.fn(async () => undefined);

    capturePaneMock.mockResolvedValueOnce(['prompt']);
    await collector.captureAndDiff('deck_alpha');

    capturePaneMock.mockResolvedValueOnce(['prompt']).mockResolvedValueOnce([
      'prompt',
      '\x1b[32m# Done\x1b[0m   ',
      '',
      '',
      'content',
    ]);

    await collector.onAgentIdle('deck_alpha', 'alpha', sendOutbound);
    expect(sendOutbound).not.toHaveBeenCalled();

    await collector.onAgentIdle('deck_alpha', 'alpha', sendOutbound);
    expect(sendOutbound).toHaveBeenCalledTimes(2);
    expect(sendOutbound).toHaveBeenNthCalledWith(1, {
      platform: 'slack',
      botId: 'bot-1',
      channelId: 'C1',
      content: '# Done\n\ncontent',
      formatting: 'markdown',
    });
    expect(sendOutbound).toHaveBeenNthCalledWith(2, {
      platform: 'discord',
      botId: 'bot-2',
      channelId: 'D1',
      content: '# Done\n\ncontent',
      formatting: 'markdown',
    });

    sendOutbound.mockRejectedValueOnce(new Error('temporary outbound failure'));
    capturePaneMock.mockResolvedValueOnce(['prompt', '# Done', '', '', 'content', '```ts', 'const x = 1;', '```']);
    await expect(collector.onAgentIdle('deck_alpha', 'alpha', sendOutbound)).resolves.toBeUndefined();
    expect(sendOutbound.mock.calls.at(-1)?.[0]).toMatchObject({ formatting: 'code' });
  });

  it('routes auto-fix sessions to the registered handler instead of outbound channels', async () => {
    const collector = await loadCollector();
    const sendOutbound = vi.fn(async () => undefined);
    const autoFixHandler = vi.fn(async () => undefined);

    capturePaneMock.mockResolvedValueOnce(['start']);
    await collector.captureAndDiff('deck_alpha');

    collector.registerAutoFixSession('deck_alpha', autoFixHandler);
    capturePaneMock.mockResolvedValueOnce(['start', 'fixed   ']);
    await collector.onAgentIdle('deck_alpha', 'alpha', sendOutbound);

    expect(autoFixHandler).toHaveBeenCalledWith('deck_alpha', 'fixed');
    expect(sendOutbound).not.toHaveBeenCalled();

    autoFixHandler.mockRejectedValueOnce(new Error('state machine failed'));
    capturePaneMock.mockResolvedValueOnce(['start', 'fixed', 'again']);
    await expect(collector.onAgentIdle('deck_alpha', 'alpha', sendOutbound)).resolves.toBeUndefined();

    collector.unregisterAutoFixSession('deck_alpha');
    capturePaneMock.mockResolvedValueOnce(['start', 'fixed', 'again', 'plain text']);
    await collector.onAgentIdle('deck_alpha', 'alpha', sendOutbound);
    expect(sendOutbound).toHaveBeenCalledWith({
      platform: 'slack',
      botId: 'bot-1',
      channelId: 'C1',
      content: 'plain text',
      formatting: 'plain',
    });
  });

  it('does not dispatch when there are no bindings for the idle project', async () => {
    const collector = await loadCollector();
    const sendOutbound = vi.fn(async () => undefined);

    capturePaneMock.mockResolvedValueOnce(['content']);
    await collector.onAgentIdle('deck_unknown', 'unknown', sendOutbound);

    expect(sendOutbound).not.toHaveBeenCalled();
  });
});
