/**
 * @vitest-environment jsdom
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';

const { voiceApi, awake } = vi.hoisted(() => ({
  voiceApi: {
    partialHandler: null as ((partial: string) => void) | null,
    listeningHandler: null as ((listening: boolean) => void) | null,
    errorHandler: null as ((error: string) => void) | null,
    startListening: vi.fn(),
    stopListening: vi.fn(),
    onAudioLevel: vi.fn(),
  },
  awake: { hold: vi.fn(), release: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts?.error ? `${key}:${String(opts.error)}` : key,
  }),
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
  voiceApi.errorHandler = null;
  voiceApi.startListening.mockReset().mockImplementation(async (
    handler: (partial: string) => void,
    onListeningChange?: (listening: boolean) => void,
    onError?: (error: string) => void,
  ) => {
    voiceApi.partialHandler = handler;
    voiceApi.listeningHandler = onListeningChange ?? null;
    voiceApi.errorHandler = onError ?? null;
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
    await vi.advanceTimersByTimeAsync(0);
    expect(onSend).toHaveBeenCalledWith('just a message');
  });

  it('flushes the native last syllables before plain send, without duplicate sends', async () => {
    const onSend = vi.fn(() => 'accepted' as const);
    render(<VoiceOverlay open initialText="" onSend={onSend} onClose={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(150);
    voiceApi.partialHandler?.('你好 hello');
    let finish!: () => void;
    voiceApi.stopListening.mockImplementationOnce(async () => {
      voiceApi.listeningHandler?.(false);
      await new Promise<void>(resolve => { finish = resolve; });
      voiceApi.partialHandler?.('你好 hello world');
    });
    fireEvent.click(screen.getByText('voice.send'));
    fireEvent.click(screen.getByText('voice.send'));
    expect(onSend).not.toHaveBeenCalled();
    finish(); await vi.advanceTimersByTimeAsync(0);
    expect(onSend.mock.calls).toEqual([['你好 hello world']]);
  });

  it('flushes final notepad text into review without auto-restarting', async () => {
    await openNotepad();
    voiceApi.partialHandler?.('agenda');
    voiceApi.stopListening.mockImplementationOnce(async () => {
      voiceApi.listeningHandler?.(false);
      voiceApi.partialHandler?.('agenda final');
    });
    fireEvent.click(document.querySelector('.voice-overlay-mic') as HTMLElement);
    await vi.advanceTimersByTimeAsync(NOTEPAD_RESTART_DELAY_MS * 3);
    expect((document.querySelector('.voice-notepad-review-transcript') as HTMLTextAreaElement)?.value ?? document.body.textContent).toContain('agenda final');
    expect(voiceApi.startListening).toHaveBeenCalledTimes(1);
  });

  it('does not send or overwrite a newly opened voice window after an older flush', async () => {
    const onSend = vi.fn(() => 'accepted' as const);
    const props = { initialText: '', onSend, onClose: vi.fn() };
    const view = render(<VoiceOverlay open {...props} />);
    await vi.advanceTimersByTimeAsync(150);
    voiceApi.partialHandler?.('old text');
    const oldPartial = voiceApi.partialHandler;
    let finish!: () => void;
    voiceApi.stopListening.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      oldPartial?.('old text final');
    });
    fireEvent.click(screen.getByText('voice.send'));
    view.rerender(<VoiceOverlay open={false} {...props} />);
    view.rerender(<VoiceOverlay open initialText="new draft" onSend={onSend} onClose={props.onClose} />);
    finish(); await vi.advanceTimersByTimeAsync(0);
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea().value).toBe('new draft');
  });

  it('does not apply a late flush over text the user manually edited', async () => {
    render(<VoiceOverlay open initialText="" onSend={vi.fn()} onClose={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(150);
    voiceApi.partialHandler?.('before');
    voiceApi.stopListening.mockImplementationOnce(async () => { voiceApi.partialHandler?.('before final'); });
    fireEvent.input(textarea(), { target: { value: 'user edit' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(textarea().value).toBe('user edit');
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

describe('VoiceOverlay mobile microphone gestures', () => {
  const pointerProperties = ['onpointerdown', 'onpointerup', 'onpointercancel', 'onlostpointercapture'];
  const descriptors = pointerProperties.map(name => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
  beforeAll(() => {
    // Same browser-capability shim used by TaskPairPanelWidth: older jsdom
    // lacks handler properties that Preact uses to lowercase pointer events.
    for (const name of pointerProperties) Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value: null });
  });
  afterAll(() => {
    pointerProperties.forEach((name, index) => {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    });
  });
  function mic() { return document.querySelector('.voice-overlay-mic') as HTMLButtonElement; }
  function pointer(type: string, pointerId = 1) {
    const event = new Event(type, { bubbles: true });
    Object.assign(event, { pointerId, button: 0 });
    fireEvent(mic(), event);
  }
  async function openVoice(onSend = vi.fn(() => 'accepted' as const)) {
    render(<VoiceOverlay open initialText="" onSend={onSend} onClose={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(150);
    return onSend;
  }

  it('keeps a short tap after implicit lost capture, and still cancels a real cancelled gesture', async () => {
    await openVoice();
    pointer('pointerdown');
    pointer('lostpointercapture'); // WebKit may release implicit touch capture before pointerup.
    pointer('pointerup');
    fireEvent.click(mic(), { detail: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(voiceApi.stopListening).toHaveBeenCalledOnce();
    pointer('pointerdown'); pointer('pointercancel');
    fireEvent.click(mic(), { detail: 1 });
    expect(voiceApi.startListening).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(400);
    pointer('pointerdown'); pointer('pointerup'); pointer('lostpointercapture');
    fireEvent.click(mic(), { detail: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(voiceApi.startListening).toHaveBeenCalledTimes(2);
  });

  it('shows starting then ready, coalesces pending starts and permits stopping startup', async () => {
    let resolve!: (ok: boolean) => void;
    voiceApi.startListening.mockReturnValueOnce(new Promise<boolean>(r => { resolve = r; }));
    render(<VoiceOverlay open onSend={vi.fn()} onClose={vi.fn()} />);
    expect(document.querySelector('.voice-overlay-status')?.textContent).toContain('voice.starting');
    await vi.advanceTimersByTimeAsync(150);
    // Click during permission/startup cancels; late success must not reactivate the sheet.
    fireEvent.click(mic());
    await vi.advanceTimersByTimeAsync(0);
    resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.voice-overlay-status')?.textContent).toContain('voice.ready');
    expect(voiceApi.startListening).toHaveBeenCalledOnce();
    expect(voiceApi.stopListening).toHaveBeenCalledOnce();
    fireEvent.click(mic());
    await vi.advanceTimersByTimeAsync(0);
    expect(voiceApi.startListening).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.voice-overlay-status')?.textContent).toContain('voice.listening');
    expect(document.querySelector('.voice-overlay-backdrop')).not.toBeNull();
    expect(document.querySelector('.voice-overlay-status')?.textContent).not.toContain('voice.paused');
  });

  it('keeps short-tap toggle and stops a long press on release without sending', async () => {
    const send = await openVoice();
    fireEvent.click(mic()); await vi.advanceTimersByTimeAsync(0); // pause
    const stops = voiceApi.stopListening.mock.calls.length;
    pointer('pointerdown');
    await vi.advanceTimersByTimeAsync(350);
    expect(voiceApi.startListening).toHaveBeenCalledTimes(2);
    voiceApi.partialHandler?.('PTT final');
    pointer('pointerup'); await vi.advanceTimersByTimeAsync(0);
    fireEvent.click(mic(), { detail: 1 }); // synthetic release click is not a tap
    expect(voiceApi.stopListening).toHaveBeenCalledTimes(stops + 1);
    expect(voiceApi.startListening).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
    expect(textarea().value).toBe('PTT final');
  });

  it('cancels an active hold safely and never turns cancellation into send', async () => {
    const send = await openVoice();
    pointer('pointerdown'); await vi.advanceTimersByTimeAsync(350);
    pointer('pointerup', 2); // another finger cannot stop this hold
    expect(voiceApi.stopListening).not.toHaveBeenCalled();
    pointer('pointercancel'); await vi.advanceTimersByTimeAsync(0);
    expect(voiceApi.stopListening).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it('double-taps within 375ms, waits for the final tail and sends once', async () => {
    const send = await openVoice();
    let release!: () => void;
    voiceApi.partialHandler?.('before');
    const drained = new Promise<void>(resolve => { release = resolve; });
    voiceApi.stopListening.mockReturnValue(drained);
    fireEvent.click(mic(), { detail: 1 });
    await vi.advanceTimersByTimeAsync(350);
    fireEvent.click(mic(), { detail: 2 });
    expect(voiceApi.stopListening).toHaveBeenCalledOnce();
    voiceApi.partialHandler?.('before last word');
    expect(send).not.toHaveBeenCalled();
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('before last word');
  });

  it('invalidates old flush waiters on close and never reuses them for a new recording', async () => {
    const send = vi.fn(() => 'accepted' as const), close = vi.fn();
    const view = render(<VoiceOverlay open initialText="" onSend={send} onClose={close} />);
    await vi.advanceTimersByTimeAsync(150);
    let release!: () => void;
    voiceApi.stopListening.mockReturnValueOnce(new Promise<void>(resolve => { release = resolve; }));
    voiceApi.partialHandler?.('old recording');
    fireEvent.click(mic(), { detail: 1 });
    await vi.advanceTimersByTimeAsync(350);
    fireEvent.click(mic(), { detail: 2 });
    fireEvent.click(screen.getByLabelText('common.close'));
    view.rerender(<VoiceOverlay open={false} onSend={send} onClose={close} />);
    view.rerender(<VoiceOverlay open initialText="new draft" onSend={send} onClose={close} />);
    await vi.advanceTimersByTimeAsync(150);
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
    expect(textarea().value).toBe('new draft');
    fireEvent.click(document.querySelector('.voice-overlay-send')!);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('new draft');
  });

  it('does not send for taps outside the double-tap window or after unmount', async () => {
    const send = await openVoice();
    voiceApi.partialHandler?.('draft');
    fireEvent.click(mic(), { detail: 1 });
    await vi.advanceTimersByTimeAsync(376);
    fireEvent.click(mic(), { detail: 2 });
    expect(send).not.toHaveBeenCalled();
    pointer('pointerdown'); cleanup();
    await vi.advanceTimersByTimeAsync(1000);
    expect(voiceApi.startListening).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
  });

  it('surfaces permission failure and runtime recognitionError with a working retry button that waits for drain and preserves the final tail', async () => {
    voiceApi.startListening.mockImplementationOnce(async (
      _handler: (partial: string) => void,
      _onListeningChange?: (listening: boolean) => void,
      onError?: (error: string) => void,
    ) => {
      onError?.('permission_denied');
      return false;
    });
    render(<VoiceOverlay open initialText="" onSend={vi.fn()} onClose={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(150);

    expect(document.querySelector('.voice-overlay-error')?.textContent).toContain('voice.mic_permission_failed');
    expect(voiceApi.stopListening).not.toHaveBeenCalled();

    // Clicking retry after permission failure clears the error and starts listening without redundant stop
    fireEvent.click(document.querySelector('.voice-overlay-retry') as HTMLElement);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.voice-overlay-error')).toBeNull();
    expect(voiceApi.startListening).toHaveBeenCalledTimes(2);
    expect(voiceApi.stopListening).not.toHaveBeenCalled();

    // Runtime native recognitionError before stop drain completes:
    let releaseDrain!: () => void;
    voiceApi.stopListening.mockReturnValueOnce(new Promise<void>((resolve) => {
      releaseDrain = resolve;
    }));
    voiceApi.partialHandler?.('first segment');
    voiceApi.errorHandler?.('Offline audio conversion failed');
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.voice-overlay-error')?.textContent).toContain('voice.error:Offline audio conversion failed');
    expect(voiceApi.stopListening).toHaveBeenCalledTimes(1);

    // Clicking retry twice while drain is still in flight coalesces and waits for final tail + drain ACK
    const retryBtn = document.querySelector('.voice-overlay-retry') as HTMLElement;
    fireEvent.click(retryBtn);
    fireEvent.click(retryBtn);
    await vi.advanceTimersByTimeAsync(0);
    expect(voiceApi.startListening).toHaveBeenCalledTimes(2);

    // Final tail arrives during drain before stop resolves, followed by delayed listeningState(false)
    voiceApi.partialHandler?.('first segment tail');
    voiceApi.listeningHandler?.(false);
    releaseDrain();
    await vi.advanceTimersByTimeAsync(0);

    expect(voiceApi.startListening).toHaveBeenCalledTimes(3);
    expect(document.querySelector('.voice-overlay-error')).toBeNull();
    expect(document.querySelector('.voice-overlay-status')?.textContent).toContain('voice.listening');
    voiceApi.partialHandler?.('second segment');
    expect(textarea().value).toBe('first segment tail second segment');
  });

  it('never auto-focuses the textarea on open or partial streaming so the soft keyboard never occludes the Send button', async () => {
    let audioLevelCb: ((level: number) => void) | null = null;
    voiceApi.onAudioLevel.mockImplementation((cb: ((level: number) => void) | null) => {
      audioLevelCb = cb;
    });
    render(<VoiceOverlay open initialText="initial" onSend={vi.fn()} onClose={vi.fn()} />);
    const ta = textarea();
    expect(document.activeElement).not.toBe(ta);
    expect(ta.readOnly).toBe(true);
    expect(ta.getAttribute('inputmode')).toBe('none');

    await vi.advanceTimersByTimeAsync(150);
    expect(document.activeElement).not.toBe(ta);
    expect(ta.readOnly).toBe(true);
    expect(ta.getAttribute('inputmode')).toBe('none');

    // One status, with activity on the editor rather than a duplicate badge.
    expect(document.querySelector('.voice-overlay-buffering')).toBeNull();
    expect(document.querySelectorAll('.voice-overlay-status [role="status"]')).toHaveLength(1);
    expect(document.querySelector('.voice-editor-marquee')).not.toBeNull();
    audioLevelCb?.(0.25);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.voice-overlay-status')?.textContent).toContain('voice.recognizing');

    // Streaming partial results must not focus the textarea unless the user manually focused it
    voiceApi.partialHandler?.('spoken words');
    await vi.advanceTimersByTimeAsync(20);
    expect(ta.value).toBe('initial spoken words');
    expect(document.activeElement).not.toBe(ta);

    // When opened in edit-only mode (autoStartListening=false), does not start mic or focus textarea
    cleanup();
    voiceApi.startListening.mockClear();
    render(<VoiceOverlay open autoStartListening={false} initialText="right swipe edit text" onSend={vi.fn()} onClose={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(300);
    expect(voiceApi.startListening).not.toHaveBeenCalled();
    expect(textarea().value).toBe('right swipe edit text');
    expect(textarea().readOnly).toBe(false);
    expect(textarea().getAttribute('inputmode')).toBeNull();
    expect(document.activeElement).not.toBe(textarea());
  });

  it('starts recognition immediately without a 150ms delay and clears voice.starting as soon as listening becomes true', async () => {
    let emitListening!: (listening: boolean) => void;
    let resolveStart!: (ok: boolean) => void;
    voiceApi.startListening.mockImplementationOnce((
      _handler: (partial: string) => void,
      onListeningChange?: (listening: boolean) => void,
    ) => {
      emitListening = onListeningChange!;
      return new Promise<boolean>((resolve) => {
        resolveStart = resolve;
      });
    });

    render(<VoiceOverlay open initialText="" onSend={vi.fn()} onClose={vi.fn()} />);

    // Called synchronously inside mount effect without waiting 150ms.
    expect(voiceApi.startListening).toHaveBeenCalledOnce();
    expect(document.querySelector('.voice-overlay-status')?.textContent).toContain('voice.starting');

    // Bridge emits listeningState='started' before startListening() resolves -> UI flips to listening immediately.
    emitListening(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.voice-overlay-status')?.textContent).toContain('voice.listening');
    expect(document.querySelector('.voice-overlay-status')?.textContent).not.toContain('voice.starting');

    resolveStart(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.voice-overlay-status')?.textContent).toContain('voice.listening');
  });

  it('defaults to fullscreen height when keyboard is closed, shrinks to visualViewport.height when IME opens, restores when closed, and cleans up viewport listeners', async () => {
    const origInnerHeight = window.innerHeight;
    const origVV = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    const vv = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
    const removeSpy = vi.spyOn(vv, 'removeEventListener');
    try {
      const view = render(<VoiceOverlay open initialText="" onSend={vi.fn()} onClose={vi.fn()} />);
      const overlay = document.querySelector('.voice-overlay') as HTMLElement;
      expect(overlay.style.height).toBe('var(--vvh, 100dvh)');

      // Soft keyboard opens -> shrinks to vv.height via resize and handles scroll
      vv.height = 510;
      vv.dispatchEvent(new Event('resize'));
      await vi.advanceTimersByTimeAsync(0);
      expect(overlay.style.height).toBe('510px');

      vv.height = 480;
      vv.dispatchEvent(new Event('scroll'));
      await vi.advanceTimersByTimeAsync(0);
      expect(overlay.style.height).toBe('480px');

      // Soft keyboard closes -> restores fullscreen height
      vv.height = 844;
      vv.dispatchEvent(new Event('resize'));
      await vi.advanceTimersByTimeAsync(0);
      expect(overlay.style.height).toBe('var(--vvh, 100dvh)');

      view.unmount();
      expect(removeSpy).toHaveBeenCalledWith('resize', expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
    } finally {
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: origInnerHeight });
      if (origVV) Object.defineProperty(window, 'visualViewport', origVV);
      else Reflect.deleteProperty(window, 'visualViewport');
    }
  });

  it('renders synchronized stream mirror with mini-robot cursor at insertPos + voiceLen while listening and hides it when paused', async () => {
    render(<VoiceOverlay open initialText="Prefix text" onSend={vi.fn()} onClose={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(0);

    // Streaming mirror is visible while starting/listening, keeping textarea value exact and mirror synced.
    const ta = textarea();
    const mirror = document.querySelector('.voice-overlay-stream-mirror') as HTMLElement;
    expect(mirror).not.toBeNull();
    expect(mirror.querySelector('.voice-streaming-robot-cursor')).not.toBeNull();
    expect(ta.classList.contains('voice-overlay-text-streaming')).toBe(true);

    voiceApi.partialHandler?.('streamed phrase');
    await vi.advanceTimersByTimeAsync(0);
    expect(ta.value).toBe('Prefix text streamed phrase');
    expect(mirror.textContent).toBe('Prefix text streamed phrase');
    expect(mirror.querySelector('.voice-streaming-robot-cursor')).not.toBeNull();

    // Syncs scrollTop cleanly from textarea to mirror
    Object.defineProperty(ta, 'scrollTop', { configurable: true, writable: true, value: 140 });
    fireEvent.scroll(ta);
    expect(mirror.scrollTop).toBe(140);

    // Pausing stops recognition and hides stream mirror so native textarea editing is unrestricted.
    fireEvent.click(mic());
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.voice-overlay-stream-mirror')).toBeNull();
    expect(ta.classList.contains('voice-overlay-text-streaming')).toBe(false);
  });

  it('blocks mobile 2-finger navigation gestures while VoiceOverlay is open and restores when closed', async () => {
    const { canHandleMobileNavigationGesture } = await import('../../src/mobile-navigation-gestures.js');
    const host = document.createElement('div');
    document.body.appendChild(host);
    expect(canHandleMobileNavigationGesture(host, { isMobile: true, document })).toBe(true);

    const { rerender } = render(
      <VoiceOverlay open onSend={vi.fn()} onClose={vi.fn()} />,
    );
    const voiceOverlay = document.querySelector('.voice-overlay')!;
    const ta = voiceOverlay.querySelector('textarea')!;
    expect(voiceOverlay.getAttribute('role')).toBe('dialog');
    expect(voiceOverlay.getAttribute('aria-modal')).toBe('true');
    expect(canHandleMobileNavigationGesture(ta, { isMobile: true, document })).toBe(false);

    rerender(<VoiceOverlay open={false} onSend={vi.fn()} onClose={vi.fn()} />);
    expect(document.querySelector('.voice-overlay')).toBeNull();
    expect(canHandleMobileNavigationGesture(host, { isMobile: true, document })).toBe(true);
    host.remove();
  });
});
