/**
 * @vitest-environment jsdom
 */
import { act } from 'preact/test-utils';
import { h } from 'preact';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACK_FAILURE_ACK_TIMEOUT,
  ACK_FAILURE_DAEMON_OFFLINE,
  MSG_COMMAND_ACK,
  MSG_COMMAND_FAILED,
} from '@shared/ack-protocol.js';
import type { WsClient, ServerMessage } from '../src/ws-client.js';
import {
  EXECUTION_CLONE_LAUNCH_TIMEOUT_MS,
  useExecutionCloneLaunch,
  type ExecutionCloneLaunchInput,
} from '../src/hooks/useExecutionCloneLaunch.js';
import { onExecutionCloneGroupReveal } from '../src/execution-clone-ui.js';

const input: ExecutionCloneLaunchInput = {
  text: 'fix the task',
  templateSessionName: 'deck_sub_template',
  maxParallelClones: 3,
  maxQueuedClones: 6,
  cloneHardTimeoutMs: 60_000,
  cloneRetentionMs: 120_000,
};

class FakeWs {
  handlers = new Set<(message: ServerMessage) => void>();
  sendExecutionClones = vi.fn((_payload: object) => true);

  onMessage(handler: (message: ServerMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(message: ServerMessage): void {
    for (const handler of this.handlers) handler(message);
  }
}

function Harness({ ws, connected = true }: { ws: FakeWs; connected?: boolean }) {
  const launch = useExecutionCloneLaunch({
    ws: ws as unknown as WsClient,
    connected,
    sessionName: 'deck_proj_brain',
    ownerSessionName: 'deck_proj_brain',
  });
  return (
    <>
      <button type="button" onClick={() => launch.launch(input)}>launch</button>
      <span data-testid="phase">{launch.state.phase}</span>
      <span data-testid="error">{launch.state.error ?? ''}</span>
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useExecutionCloneLaunch', () => {
  it('tracks the exact command ack and reveals the accepted clone group', () => {
    const ws = new FakeWs();
    const revealed = vi.fn();
    const off = onExecutionCloneGroupReveal(revealed);
    render(<Harness ws={ws} />);

    fireEvent.click(screen.getByText('launch'));
    expect(screen.getByTestId('phase').textContent).toBe('pending');
    expect(ws.sendExecutionClones).toHaveBeenCalledTimes(1);
    const payload = ws.sendExecutionClones.mock.calls[0][0] as {
      commandId: string;
      dedicatedExecutionRouting: { maxParallelClones: number };
    };
    expect(payload.dedicatedExecutionRouting.maxParallelClones).toBe(3);

    act(() => ws.emit({
      type: MSG_COMMAND_ACK,
      commandId: payload.commandId,
      status: 'accepted',
      session: 'deck_proj_brain',
    }));

    expect(screen.getByTestId('phase').textContent).toBe('success');
    expect(revealed).toHaveBeenCalledWith({
      ownerSessionName: 'deck_proj_brain',
      parentRunId: `generic-execution-${payload.commandId}`,
    });
    off();
  });

  it('ignores acknowledgements for another command or session', () => {
    const ws = new FakeWs();
    render(<Harness ws={ws} />);

    fireEvent.click(screen.getByText('launch'));
    const payload = ws.sendExecutionClones.mock.calls[0][0] as { commandId: string };
    act(() => ws.emit({
      type: MSG_COMMAND_ACK,
      commandId: 'another-command',
      status: 'accepted',
      session: 'deck_proj_brain',
    }));
    expect(screen.getByTestId('phase').textContent).toBe('pending');

    act(() => ws.emit({
      type: MSG_COMMAND_ACK,
      commandId: payload.commandId,
      status: 'accepted',
      session: 'deck_other_brain',
    }));
    expect(screen.getByTestId('phase').textContent).toBe('pending');

    act(() => ws.emit({
      type: MSG_COMMAND_ACK,
      commandId: payload.commandId,
      status: 'accepted',
      session: 'deck_proj_brain',
    }));
    expect(screen.getByTestId('phase').textContent).toBe('success');
  });

  it('surfaces daemon rejection and server-level command failure', () => {
    const ws = new FakeWs();
    render(<Harness ws={ws} />);

    fireEvent.click(screen.getByText('launch'));
    const first = ws.sendExecutionClones.mock.calls[0][0] as { commandId: string };
    act(() => ws.emit({
      type: MSG_COMMAND_ACK,
      commandId: first.commandId,
      status: 'error',
      session: 'deck_proj_brain',
      error: 'capacity_full',
    }));
    expect(screen.getByTestId('phase').textContent).toBe('error');
    expect(screen.getByTestId('error').textContent).toBe('capacity_full');

    fireEvent.click(screen.getByText('launch'));
    const second = ws.sendExecutionClones.mock.calls[1][0] as { commandId: string };
    act(() => ws.emit({
      type: MSG_COMMAND_FAILED,
      commandId: second.commandId,
      session: 'deck_proj_brain',
      reason: 'daemon_offline',
      retryable: false,
    }));
    expect(screen.getByTestId('phase').textContent).toBe('error');
    expect(screen.getByTestId('error').textContent).toBe('daemon_offline');
  });

  it('keeps the button pending until the real ack budget expires', () => {
    vi.useFakeTimers();
    const ws = new FakeWs();
    render(<Harness ws={ws} />);

    fireEvent.click(screen.getByText('launch'));
    expect(screen.getByTestId('phase').textContent).toBe('pending');
    act(() => vi.advanceTimersByTime(EXECUTION_CLONE_LAUNCH_TIMEOUT_MS));
    expect(screen.getByTestId('phase').textContent).toBe('error');
    expect(screen.getByTestId('error').textContent).toBe(ACK_FAILURE_ACK_TIMEOUT);
  });

  it('reports an immediate local failure when the socket declines the send', () => {
    const ws = new FakeWs();
    ws.sendExecutionClones.mockReturnValue(false);
    render(<Harness ws={ws} />);

    fireEvent.click(screen.getByText('launch'));
    expect(screen.getByTestId('phase').textContent).toBe('error');
    expect(screen.getByTestId('error').textContent).toBe('daemon_offline');
  });

  it('surfaces a synchronous send failure instead of leaving the launch pending', () => {
    const ws = new FakeWs();
    ws.sendExecutionClones.mockImplementation(() => {
      throw new Error('payload_too_large');
    });
    render(<Harness ws={ws} />);

    fireEvent.click(screen.getByText('launch'));
    expect(screen.getByTestId('phase').textContent).toBe('error');
    expect(screen.getByTestId('error').textContent).toBe('payload_too_large');
  });

  it('ends a pending launch honestly when the websocket instance is replaced', () => {
    const firstWs = new FakeWs();
    const secondWs = new FakeWs();
    const view = render(<Harness ws={firstWs} />);

    fireEvent.click(screen.getByText('launch'));
    expect(screen.getByTestId('phase').textContent).toBe('pending');

    view.rerender(<Harness ws={secondWs} />);
    expect(screen.getByTestId('phase').textContent).toBe('error');
    expect(screen.getByTestId('error').textContent).toBe(ACK_FAILURE_DAEMON_OFFLINE);

    fireEvent.click(screen.getByText('launch'));
    expect(secondWs.sendExecutionClones).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('phase').textContent).toBe('pending');
  });
});
