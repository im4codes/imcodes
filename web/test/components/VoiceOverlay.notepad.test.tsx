/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';

const { voiceApi, awake } = vi.hoisted(() => ({
  voiceApi: {
    partialHandler: null as ((partial: string) => void) | null,
    listeningHandler: null as ((listening: boolean) => void) | null,
    startListening: vi.fn(),
    stopListening: vi.fn(),
    onAudioLevel: vi.fn(),
  },
  awake: { hold: vi.fn(), release: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../src/components/VoiceInput.js', () => ({
  onAudioLevel: (...args: unknown[]) => voiceApi.onAudioLevel(...args),
  startListening: (...args: unknown[]) => voiceApi.startListening(...args),
  stopListening: (...args: unknown[]) => voiceApi.stopListening(...args),
}));

vi.mock('../../src/screen-awake.js', () => ({
  holdScreenAwake: () => { awake.hold(); return awake.release; },
}));

import {
  NOTEPAD_MAX_SHORT_SEGMENTS,
  NOTEPAD_RESTART_DELAY_MS,
  NOTEPAD_SHORT_SEGMENT_MS,
  VoiceOverlay,
} from '../../src/components/VoiceOverlay.js';

/** Native recognizer ending a segment by itself (silence / per-request cap). */
function recognizerEndsSegment(): void {
  voiceApi.listeningHandler?.(false);
}

function textarea(): HTMLTextAreaElement {
  return document.querySelector('.voice-overlay-text') as HTMLTextAreaElement;
}

async function openNotepad(onSend = vi.fn(() => 'accepted' as const)) {
  render(<VoiceOverlay open initialText="" onSend={onSend} onClose={vi.fn()} />);
  await vi.advanceTimersByTimeAsync(150);
  expect(voiceApi.startListening).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText(/voice\.notepad$/));
  await vi.advanceTimersByTimeAsync(0);
  return onSend;
}

beforeEach(() => {
  vi.useFakeTimers();
  voiceApi.partialHandler = null;
  voiceApi.listeningHandler = null;
  voiceApi.startListening.mockReset().mockImplementation(async (
    handler: (partial: string) => void,
    onListeningChange?: (listening: boolean) => void,
  ) => {
    voiceApi.partialHandler = handler;
    voiceApi.listeningHandler = onListeningChange ?? null;
    onListeningChange?.(true);
    return true;
  });
  voiceApi.stopListening.mockReset().mockResolvedValue(undefined);
  voiceApi.onAudioLevel.mockReset();
  awake.hold.mockReset();
  awake.release.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('VoiceOverlay notepad mode', () => {
  it('restarts the recognizer after each segment and keeps one transcript, one line per segment', async () => {
    await openNotepad();

    vi.advanceTimersByTime(NOTEPAD_SHORT_SEGMENT_MS);
    voiceApi.partialHandler?.('first point');
    recognizerEndsSegment();
    await vi.advanceTimersByTimeAsync(NOTEPAD_RESTART_DELAY_MS);
    expect(voiceApi.startListening).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(NOTEPAD_SHORT_SEGMENT_MS);
    voiceApi.partialHandler?.('second');
    voiceApi.partialHandler?.('second point');
    recognizerEndsSegment();
    await vi.advanceTimersByTimeAsync(NOTEPAD_RESTART_DELAY_MS);
    expect(voiceApi.startListening).toHaveBeenCalledTimes(3);

    expect(textarea().value).toBe('first point\nsecond point');
  });

  it('does not restart when the recognizer ends outside notepad mode', async () => {
    render(<VoiceOverlay open initialText="" onSend={vi.fn()} onClose={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(150);
    voiceApi.partialHandler?.('hello');
    recognizerEndsSegment();
    await vi.advanceTimersByTimeAsync(NOTEPAD_RESTART_DELAY_MS * 4);
    expect(voiceApi.startListening).toHaveBeenCalledTimes(1);
  });

  it('stops for good when the user taps the mic, even if the recognizer then reports its end', async () => {
    await openNotepad();
    voiceApi.partialHandler?.('agenda');
    fireEvent.click(document.querySelector('.voice-overlay-mic') as HTMLElement);
    await vi.advanceTimersByTimeAsync(0);
    recognizerEndsSegment();
    await vi.advanceTimersByTimeAsync(NOTEPAD_RESTART_DELAY_MS * 4);
    expect(voiceApi.startListening).toHaveBeenCalledTimes(1);
    expect(textarea().value).toBe('agenda');
  });

  it('gives up after repeated immediate segment ends instead of looping', async () => {
    await openNotepad();
    for (let i = 0; i < NOTEPAD_MAX_SHORT_SEGMENTS + 3; i++) {
      recognizerEndsSegment();
      await vi.advanceTimersByTimeAsync(NOTEPAD_RESTART_DELAY_MS);
    }
    // The initial start plus one restart per short segment before the cap.
    expect(voiceApi.startListening).toHaveBeenCalledTimes(NOTEPAD_MAX_SHORT_SEGMENTS);

    // Tapping the mic is a user action and re-arms notepad listening.
    fireEvent.click(document.querySelector('.voice-overlay-mic') as HTMLElement);
    await vi.advanceTimersByTimeAsync(0);
    expect(voiceApi.startListening).toHaveBeenCalledTimes(NOTEPAD_MAX_SHORT_SEGMENTS + 1);
    vi.advanceTimersByTime(NOTEPAD_SHORT_SEGMENT_MS);
    recognizerEndsSegment();
    await vi.advanceTimersByTimeAsync(NOTEPAD_RESTART_DELAY_MS);
    expect(voiceApi.startListening).toHaveBeenCalledTimes(NOTEPAD_MAX_SHORT_SEGMENTS + 2);
  });

  it('stops restarting when the recognizer cannot start', async () => {
    await openNotepad();
    voiceApi.startListening.mockImplementation(async () => false);
    vi.advanceTimersByTime(NOTEPAD_SHORT_SEGMENT_MS);
    recognizerEndsSegment();
    await vi.advanceTimersByTimeAsync(NOTEPAD_RESTART_DELAY_MS * 10);
    expect(voiceApi.startListening).toHaveBeenCalledTimes(2);
    // A late end event from the failed attempt must not re-arm the loop.
    recognizerEndsSegment();
    await vi.advanceTimersByTimeAsync(NOTEPAD_RESTART_DELAY_MS * 10);
    expect(voiceApi.startListening).toHaveBeenCalledTimes(2);
  });

  it('sends the transcript with the summary request to the session', async () => {
    const onSend = await openNotepad();
    voiceApi.partialHandler?.('we ship on friday');
    fireEvent.click(screen.getByText('voice.notepad_send'));
    expect(onSend).toHaveBeenCalledWith('voice.notepad_summary_prompt\n\nwe ship on friday');
  });

  it('sends plain text when notepad mode is off', async () => {
    const onSend = vi.fn(() => 'accepted' as const);
    render(<VoiceOverlay open initialText="" onSend={onSend} onClose={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(150);
    voiceApi.partialHandler?.('just a message');
    fireEvent.click(screen.getByText('voice.send'));
    expect(onSend).toHaveBeenCalledWith('just a message');
  });

  it('keeps the screen awake only while notepad mode is on', async () => {
    await openNotepad();
    expect(awake.hold).toHaveBeenCalledTimes(1);
    expect(awake.release).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(/voice\.notepad$/));
    await vi.advanceTimersByTimeAsync(0);
    expect(awake.release).toHaveBeenCalledTimes(1);
  });

  it('releases the screen when the overlay closes during a notepad', async () => {
    await openNotepad();
    fireEvent.click(document.querySelector('.voice-overlay-close') as HTMLElement);
    cleanup();
    expect(awake.release).toHaveBeenCalled();
  });
});
