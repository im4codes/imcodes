import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../src/api.js', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

describe('message pins API client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockResolvedValue({ pins: [], pin: { id: 'pin-1' }, ok: true });
  });

  it('uses the mounted /api route and keeps the original session on mutations', async () => {
    const { fetchMessagePins, removeMessagePin, saveMessagePin } = await import('../src/api/message-pins.js');

    await fetchMessagePins('server / 1');
    await saveMessagePin('server / 1', 'deck_sub_一', {
      eventId: 'event-1',
      eventTs: 123,
      eventType: 'assistant.text',
      text: 'Pinned text',
    });
    await removeMessagePin('server / 1', 'deck_sub_一', 'pin / 1');

    expect(apiFetchMock.mock.calls).toEqual([
      ['/api/message-pins?serverId=server+%2F+1'],
      ['/api/message-pins?serverId=server+%2F+1&sessionName=deck_sub_%E4%B8%80', {
        method: 'POST',
        body: JSON.stringify({
          eventId: 'event-1',
          eventTs: 123,
          eventType: 'assistant.text',
          text: 'Pinned text',
        }),
      }],
      ['/api/message-pins/pin%20%2F%201?serverId=server+%2F+1&sessionName=deck_sub_%E4%B8%80', {
        method: 'DELETE',
      }],
    ]);
  });
});
