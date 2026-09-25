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
import {
  NOTEPAD_DRAFT_SAVE_INTERVAL_MS,
  readVoiceNotepadDraft,
  voiceNotepadDraftKey,
  writeVoiceNotepadDraft,
  type VoiceNotepadSendRequest,
} from '../../src/voice-notepad.js';

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
  vi.restoreAllMocks();
  localStorage.clear();
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

  it('sends the transcript with the summary request to the session, after review', async () => {
    const onSend = await openNotepad();
    voiceApi.partialHandler?.('we ship on friday');
    fireEvent.click(screen.getByText('voice.notepad_send'));
    await vi.advanceTimersByTimeAsync(0);
    // Send in notepad mode reviews first; nothing has been sent yet.
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector('.voice-notepad-review-send') as HTMLElement);
    expect(onSend).toHaveBeenCalledWith(
      'voice.notepad_summary_instruction\n\nvoice.notepad_transcript_label\n\nwe ship on friday',
    );
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

const SCOPE = 'srv-1:session:deck_app_brain';

function seedDraft(text: string, scope = SCOPE): void {
  expect(writeVoiceNotepadDraft({
    version: 1,
    scope,
    text,
    segments: [{ atMs: 1_000, text }],
    startedAt: 1_000,
    updatedAt: 2_000,
  })).toBe(true);
}

function renderNotepadOverlay(overrides: {
  onSend?: ReturnType<typeof vi.fn>;
  onClose?: ReturnType<typeof vi.fn>;
  onSendNotepad?: (request: VoiceNotepadSendRequest) => Promise<'accepted' | 'pending' | 'rejected'>;
  draftScope?: string;
  initialText?: string;
} = {}) {
  const onSend = overrides.onSend ?? vi.fn(() => 'accepted' as const);
  const onClose = overrides.onClose ?? vi.fn();
  render(
    <VoiceOverlay
      open
      initialText={overrides.initialText ?? ''}
      onSend={onSend}
      onClose={onClose}
      onSendNotepad={overrides.onSendNotepad}
      draftScope={overrides.draftScope ?? SCOPE}
      sessionLabel="Brain"
    />,
  );
  return { onSend, onClose };
}

async function startNotepad(): Promise<void> {
  await vi.advanceTimersByTimeAsync(150);
  fireEvent.click(screen.getByText(/voice\.notepad$/));
  await vi.advanceTimersByTimeAsync(0);
}

function reviewField(kind: 'instruction' | 'transcript'): HTMLTextAreaElement {
  return document.querySelector(`.voice-notepad-review-${kind}`) as HTMLTextAreaElement;
}

describe('VoiceOverlay notepad draft and review', () => {
  it('writes the running notepad to a local draft every few seconds, with segment times', async () => {
    renderNotepadOverlay();
    await startNotepad();
    voiceApi.partialHandler?.('decisions so far');
    expect(localStorage.getItem(voiceNotepadDraftKey(SCOPE))).toBeNull();

    await vi.advanceTimersByTimeAsync(NOTEPAD_DRAFT_SAVE_INTERVAL_MS);
    expect(readVoiceNotepadDraft(SCOPE)?.text).toBe('decisions so far');

    // A committed segment is recorded with its time since the notepad began.
    vi.advanceTimersByTime(NOTEPAD_SHORT_SEGMENT_MS);
    recognizerEndsSegment();
    const draft = readVoiceNotepadDraft(SCOPE);
    expect(draft?.segments).toEqual([
      { atMs: expect.any(Number), text: 'decisions so far' },
    ]);
    expect(draft!.segments[0]!.atMs).toBeGreaterThanOrEqual(NOTEPAD_DRAFT_SAVE_INTERVAL_MS);
  });

  it('offers an unfinished draft for its session instead of starting dictation, and resumes it', async () => {
    seedDraft('first point');
    renderNotepadOverlay();
    await vi.advanceTimersByTimeAsync(150);
    expect(document.querySelector('.voice-notepad-recovery')).not.toBeNull();
    expect(voiceApi.startListening).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('voice.notepad_resume'));
    await vi.advanceTimersByTimeAsync(0);
    expect(voiceApi.startListening).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.voice-notepad-recovery')).toBeNull();
    expect(screen.getByText(/voice\.notepad$/).getAttribute('aria-pressed')).toBe('true');

    voiceApi.partialHandler?.('second point');
    expect(textarea().value).toBe('first point\nsecond point');
  });

  it('never offers one session\'s draft in another session', async () => {
    seedDraft('someone else\'s meeting', 'srv-1:session:other');
    renderNotepadOverlay();
    await vi.advanceTimersByTimeAsync(150);
    expect(document.querySelector('.voice-notepad-recovery')).toBeNull();
    expect(voiceApi.startListening).toHaveBeenCalledTimes(1);
  });

  it('asks before discarding an offered draft, then deletes it', async () => {
    seedDraft('first point');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderNotepadOverlay();
    await vi.advanceTimersByTimeAsync(150);

    fireEvent.click(screen.getByText('voice.notepad_discard'));
    expect(confirm).toHaveBeenCalledWith('voice.notepad_discard_confirm');
    expect(readVoiceNotepadDraft(SCOPE)?.text).toBe('first point');

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByText('voice.notepad_discard'));
    await vi.advanceTimersByTimeAsync(0);
    expect(readVoiceNotepadDraft(SCOPE)).toBeNull();
    expect(document.querySelector('.voice-notepad-recovery')).toBeNull();
    // Back to what voice input was opened for: ordinary dictation.
    expect(voiceApi.startListening).toHaveBeenCalledTimes(1);
  });

  it('opens review on stop and sends the edited instruction and transcript to the bound session', async () => {
    const onSendNotepad = vi.fn(async (request: VoiceNotepadSendRequest) => {
      request.onAccepted();
      return 'accepted' as const;
    });
    const { onClose, onSend } = renderNotepadOverlay({ onSendNotepad });
    await startNotepad();
    voiceApi.partialHandler?.('raw words');

    // Tapping the mic stops the notepad: review, not another restart.
    fireEvent.click(document.querySelector('.voice-overlay-mic') as HTMLElement);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.voice-notepad-review-target')?.textContent)
      .toBe('voice.notepad_review_target');
    expect(reviewField('instruction').value).toBe('voice.notepad_summary_instruction');
    expect(reviewField('transcript').value).toBe('raw words');

    fireEvent.input(reviewField('instruction'), { target: { value: 'Summarize for the team' } });
    fireEvent.input(reviewField('transcript'), { target: { value: 'edited words' } });
    fireEvent.click(document.querySelector('.voice-notepad-review-send') as HTMLElement);
    await vi.advanceTimersByTimeAsync(0);

    expect(onSendNotepad).toHaveBeenCalledWith({
      instruction: 'Summarize for the team',
      transcript: 'edited words',
      onAccepted: expect.any(Function),
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    // Sent: the draft is gone and nothing writes it back.
    expect(readVoiceNotepadDraft(SCOPE)).toBeNull();
    await vi.advanceTimersByTimeAsync(NOTEPAD_DRAFT_SAVE_INTERVAL_MS * 2);
    expect(readVoiceNotepadDraft(SCOPE)).toBeNull();
  });

  it('keeps the notepad on the device and sends nothing when closed without sending', async () => {
    const onSendNotepad = vi.fn();
    const { onSend } = renderNotepadOverlay({ onSendNotepad });
    await startNotepad();
    voiceApi.partialHandler?.('private words');
    fireEvent.click(document.querySelector('.voice-overlay-close') as HTMLElement);
    expect(onSend).not.toHaveBeenCalled();
    expect(onSendNotepad).not.toHaveBeenCalled();
    expect(readVoiceNotepadDraft(SCOPE)?.text).toBe('private words');
  });

  it('discards from review only after confirmation, deleting the draft and sending nothing', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onSendNotepad = vi.fn();
    const { onClose, onSend } = renderNotepadOverlay({ onSendNotepad });
    await startNotepad();
    voiceApi.partialHandler?.('scrap this');
    await vi.advanceTimersByTimeAsync(NOTEPAD_DRAFT_SAVE_INTERVAL_MS);
    fireEvent.click(screen.getByText('voice.notepad_send'));
    await vi.advanceTimersByTimeAsync(0);

    fireEvent.click(document.querySelector('.voice-notepad-discard') as HTMLElement);
    expect(confirm).toHaveBeenCalledWith('voice.notepad_discard_confirm');
    expect(onClose).toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(onSendNotepad).not.toHaveBeenCalled();
    expect(readVoiceNotepadDraft(SCOPE)).toBeNull();
  });

  it('keeps the draft and says so when the send is refused', async () => {
    const onSendNotepad = vi.fn(async () => 'rejected' as const);
    const { onClose } = renderNotepadOverlay({ onSendNotepad });
    await startNotepad();
    voiceApi.partialHandler?.('try again later');
    fireEvent.click(screen.getByText('voice.notepad_send'));
    await vi.advanceTimersByTimeAsync(0);
    fireEvent.click(document.querySelector('.voice-notepad-review-send') as HTMLElement);
    await vi.advanceTimersByTimeAsync(0);

    expect(document.querySelector('.voice-notepad-review-error')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(readVoiceNotepadDraft(SCOPE)?.text).toBe('try again later');
  });

  it('continues recording from review with the edits kept', async () => {
    renderNotepadOverlay({ onSendNotepad: vi.fn() });
    await startNotepad();
    voiceApi.partialHandler?.('part one');
    fireEvent.click(document.querySelector('.voice-overlay-mic') as HTMLElement);
    await vi.advanceTimersByTimeAsync(0);
    fireEvent.input(reviewField('transcript'), { target: { value: 'part one, fixed' } });

    fireEvent.click(screen.getByText('voice.notepad_continue'));
    await vi.advanceTimersByTimeAsync(0);
    // The opening's own start, then the restart that continuing asks for.
    expect(voiceApi.startListening).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.voice-notepad-review')).toBeNull();
    voiceApi.partialHandler?.('part two');
    expect(textarea().value).toBe('part one, fixed\npart two');
  });

  it('sends a draft offered after a restart straight to review', async () => {
    seedDraft('from before the crash');
    const onSendNotepad = vi.fn(async (request: VoiceNotepadSendRequest) => {
      request.onAccepted();
      return 'accepted' as const;
    });
    renderNotepadOverlay({ onSendNotepad });
    await vi.advanceTimersByTimeAsync(150);
    fireEvent.click(screen.getByText('voice.notepad_send'));
    expect(reviewField('transcript').value).toBe('from before the crash');
    fireEvent.click(document.querySelector('.voice-notepad-review-send') as HTMLElement);
    await vi.advanceTimersByTimeAsync(0);
    expect(onSendNotepad).toHaveBeenCalledWith(expect.objectContaining({
      transcript: 'from before the crash',
    }));
    expect(readVoiceNotepadDraft(SCOPE)).toBeNull();
  });
});

describe('VoiceOverlay notepad never loses an unsent draft', () => {
  it('cannot start a fresh notepad over the unsent one it is offering', async () => {
    seedDraft('yesterday\'s meeting');
    renderNotepadOverlay();
    await vi.advanceTimersByTimeAsync(150);
    const toggle = screen.getByText(/voice\.notepad$/) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);

    // Even a toggle that gets through must not start over the offered draft.
    fireEvent.click(toggle);
    await vi.advanceTimersByTimeAsync(0);
    voiceApi.partialHandler?.('a new meeting');
    vi.advanceTimersByTime(NOTEPAD_SHORT_SEGMENT_MS);
    recognizerEndsSegment();
    await vi.advanceTimersByTimeAsync(NOTEPAD_DRAFT_SAVE_INTERVAL_MS * 2);
    fireEvent.click(document.querySelector('.voice-overlay-close') as HTMLElement);

    expect(readVoiceNotepadDraft(SCOPE)?.text).toBe('yesterday\'s meeting');
  });

  it('offers the unsent notepad instead of starting over it when the toggle is used', async () => {
    renderNotepadOverlay();
    await vi.advanceTimersByTimeAsync(150);
    // Another window on the same session stored a notepad after this opened.
    seedDraft('from the other window');
    fireEvent.click(screen.getByText(/voice\.notepad$/));
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.voice-notepad-recovery')).not.toBeNull();
    expect(screen.getByText(/voice\.notepad$/).getAttribute('aria-pressed')).toBe('false');
    expect(readVoiceNotepadDraft(SCOPE)?.text).toBe('from the other window');
  });

  it('never writes over a different notepad stored under the same session while recording', async () => {
    renderNotepadOverlay();
    await startNotepad();
    voiceApi.partialHandler?.('mine');
    await vi.advanceTimersByTimeAsync(NOTEPAD_DRAFT_SAVE_INTERVAL_MS);
    expect(readVoiceNotepadDraft(SCOPE)?.text).toBe('mine');

    // A second window on the same session starts its own notepad.
    writeVoiceNotepadDraft({
      version: 1,
      scope: SCOPE,
      text: 'theirs',
      segments: [],
      startedAt: 42,
      updatedAt: 43,
    });
    voiceApi.partialHandler?.('mine, longer');
    await vi.advanceTimersByTimeAsync(NOTEPAD_DRAFT_SAVE_INTERVAL_MS);
    expect(readVoiceNotepadDraft(SCOPE)?.text).toBe('theirs');
  });
});

describe('VoiceOverlay recovered notepad and the composer text', () => {
  it('keeps the composer text on screen when resuming, so a send never clears unseen text', async () => {
    seedDraft('meeting text');
    renderNotepadOverlay({ initialText: 'typed before' });
    await vi.advanceTimersByTimeAsync(150);
    fireEvent.click(screen.getByText('voice.notepad_resume'));
    await vi.advanceTimersByTimeAsync(0);
    expect(textarea().value).toBe('typed before\nmeeting text');
    voiceApi.partialHandler?.('more');
    expect(textarea().value).toBe('typed before\nmeeting text\nmore');
  });

  it('shows the composer text in review when a recovered notepad is sent straight away', async () => {
    seedDraft('meeting text');
    renderNotepadOverlay({ initialText: 'typed before', onSendNotepad: vi.fn() });
    await vi.advanceTimersByTimeAsync(150);
    fireEvent.click(screen.getByText('voice.notepad_send'));
    expect(reviewField('transcript').value).toBe('typed before\nmeeting text');
  });

  it('does not repeat composer text the recovered notepad already starts with', async () => {
    seedDraft('typed before\nmeeting text');
    renderNotepadOverlay({ initialText: 'typed before', onSendNotepad: vi.fn() });
    await vi.advanceTimersByTimeAsync(150);
    fireEvent.click(screen.getByText('voice.notepad_send'));
    expect(reviewField('transcript').value).toBe('typed before\nmeeting text');
  });
});
