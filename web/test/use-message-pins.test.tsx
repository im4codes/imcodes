/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import type { MessagePin } from '../../shared/message-pins.js';

const fetchPinsMock = vi.hoisted(() => vi.fn());
const savePinMock = vi.hoisted(() => vi.fn());
const removePinMock = vi.hoisted(() => vi.fn());
vi.mock('../src/api/message-pins.js', () => ({
  fetchMessagePins: fetchPinsMock,
  saveMessagePin: savePinMock,
  removeMessagePin: removePinMock,
}));

import {
  __resetMessagePinsCacheForTests,
  clearMessagePinsCache,
  useMessagePins,
} from '../src/hooks/useMessagePins.js';

function savedPin(): MessagePin {
  return {
    id: 'pin-1',
    serverId: 'srv-1',
    sessionName: 'deck_main',
    eventId: 'event-1',
    eventTs: 10,
    eventType: 'user.message',
    text: 'saved',
    createdAt: 10,
    updatedAt: 10,
  };
}

describe('useMessagePins shared server cache', () => {
  beforeEach(() => {
    cleanup();
    __resetMessagePinsCacheForTests();
    fetchPinsMock.mockReset().mockResolvedValue([]);
    savePinMock.mockReset().mockResolvedValue(savedPin());
    removePinMock.mockReset().mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  it('uses one PostgreSQL list request for multiple chat windows and fans mutations out to all of them', async () => {
    function Probe({ id }: { id: string }) {
      const pins = useMessagePins('srv-1', 'deck_main');
      return (
        <div>
          <span data-testid={`count-${id}`}>{pins.pins.length}</span>
          <button data-testid={`pin-${id}`} onClick={() => void pins.pinMessage({
            eventId: 'event-1', eventTs: 10, eventType: 'user.message', text: 'saved',
          })}>pin</button>
        </div>
      );
    }
    render(<><Probe id="a" /><Probe id="b" /></>);
    await waitFor(() => expect(fetchPinsMock).toHaveBeenCalledTimes(1));
    await act(async () => { fireEvent.click(screen.getByTestId('pin-a')); });
    await waitFor(() => {
      expect(screen.getByTestId('count-a').textContent).toBe('1');
      expect(screen.getByTestId('count-b').textContent).toBe('1');
    });
    expect(savePinMock).toHaveBeenCalledTimes(1);
  });

  it('drops the per-server cache at an authentication boundary', async () => {
    let resolveFirst!: (pins: MessagePin[]) => void;
    fetchPinsMock.mockImplementationOnce(() => new Promise<MessagePin[]>((resolve) => {
      resolveFirst = resolve;
    }));
    function Probe() {
      useMessagePins('srv-1', 'deck_main');
      return <div>probe</div>;
    }

    const first = render(<Probe />);
    await waitFor(() => expect(fetchPinsMock).toHaveBeenCalledTimes(1));
    first.unmount();
    clearMessagePinsCache();
    await act(async () => resolveFirst([savedPin()]));
    render(<Probe />);

    await waitFor(() => expect(fetchPinsMock).toHaveBeenCalledTimes(2));
  });
});
