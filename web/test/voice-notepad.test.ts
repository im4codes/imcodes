/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { INLINE_PASTE_TEXT_CHAR_LIMIT } from '../src/composer-inline-limit.js';
import {
  NOTEPAD_INLINE_TRANSCRIPT_CHAR_LIMIT,
  NOTEPAD_MAX_DRAFT_SEGMENTS,
  buildNotepadInlineMessage,
  buildNotepadTranscriptFileName,
  deleteVoiceNotepadDraft,
  needsNotepadTranscriptAttachment,
  readVoiceNotepadDraft,
  voiceNotepadDraftKey,
  writeVoiceNotepadDraft,
  type VoiceNotepadDraft,
} from '../src/voice-notepad.js';

const SCOPE = 'srv-1:sub:sub_42';

function draft(overrides: Partial<VoiceNotepadDraft> = {}): VoiceNotepadDraft {
  return {
    version: 1,
    scope: SCOPE,
    text: 'agenda\nowners',
    segments: [{ atMs: 0, text: 'agenda' }, { atMs: 4_000, text: 'owners' }],
    startedAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

afterEach(() => localStorage.clear());

describe('voice notepad inline threshold', () => {
  it('is the composer\'s own inline limit, so a transcript is treated like the same text pasted in', () => {
    expect(NOTEPAD_INLINE_TRANSCRIPT_CHAR_LIMIT).toBe(INLINE_PASTE_TEXT_CHAR_LIMIT);
  });

  it('keeps a transcript at the limit inline and attaches one past it', () => {
    expect(needsNotepadTranscriptAttachment('x'.repeat(NOTEPAD_INLINE_TRANSCRIPT_CHAR_LIMIT))).toBe(false);
    expect(needsNotepadTranscriptAttachment('x'.repeat(NOTEPAD_INLINE_TRANSCRIPT_CHAR_LIMIT + 1))).toBe(true);
  });
});

describe('voice notepad message', () => {
  it('puts the instruction, the transcript label and the transcript in one message', () => {
    expect(buildNotepadInlineMessage('  Summarize it.  ', 'Transcript:', 'we ship friday'))
      .toBe('Summarize it.\n\nTranscript:\n\nwe ship friday');
  });

  it('sends the bare transcript when the instruction was cleared', () => {
    expect(buildNotepadInlineMessage('   ', 'Transcript:', 'we ship friday')).toBe('we ship friday');
  });

  it('names the transcript file as Markdown', () => {
    expect(buildNotepadTranscriptFileName(new Date('2026-09-25T10:11:12.345Z')))
      .toBe('voice-notepad-2026-09-25T10-11-12-345Z.md');
  });
});

describe('voice notepad draft storage', () => {
  it('round-trips a draft under its session key in localStorage', () => {
    expect(writeVoiceNotepadDraft(draft({ instruction: 'edited' }))).toBe(true);
    expect(localStorage.getItem(voiceNotepadDraftKey(SCOPE))).not.toBeNull();
    expect(readVoiceNotepadDraft(SCOPE)).toEqual(draft({ instruction: 'edited' }));
    deleteVoiceNotepadDraft(SCOPE);
    expect(readVoiceNotepadDraft(SCOPE)).toBeNull();
  });

  it('keeps sessions apart, main and sub alike', () => {
    writeVoiceNotepadDraft(draft());
    expect(readVoiceNotepadDraft('srv-1:session:deck_app_brain')).toBeNull();
    expect(readVoiceNotepadDraft('srv-2:sub:sub_42')).toBeNull();
  });

  it('ignores a corrupt, foreign or empty entry instead of offering it', () => {
    localStorage.setItem(voiceNotepadDraftKey(SCOPE), '{not json');
    expect(readVoiceNotepadDraft(SCOPE)).toBeNull();
    localStorage.setItem(voiceNotepadDraftKey(SCOPE), JSON.stringify(draft({ scope: 'srv-1:sub:other' })));
    expect(readVoiceNotepadDraft(SCOPE)).toBeNull();
    writeVoiceNotepadDraft(draft({ text: '  \n ' }));
    expect(readVoiceNotepadDraft(SCOPE)).toBeNull();
  });

  it('bounds the segment record of a very long meeting', () => {
    const segments = Array.from({ length: NOTEPAD_MAX_DRAFT_SEGMENTS + 10 }, (_, index) => ({
      atMs: index,
      text: `s${index}`,
    }));
    writeVoiceNotepadDraft(draft({ segments }));
    const stored = readVoiceNotepadDraft(SCOPE);
    expect(stored?.segments).toHaveLength(NOTEPAD_MAX_DRAFT_SEGMENTS);
    expect(stored?.segments.at(-1)).toEqual({ atMs: NOTEPAD_MAX_DRAFT_SEGMENTS + 9, text: `s${NOTEPAD_MAX_DRAFT_SEGMENTS + 9}` });
  });

  it('reports a refused write rather than throwing', () => {
    const full = {
      setItem: () => { throw new DOMException('full', 'QuotaExceededError'); },
      getItem: () => null,
      removeItem: () => {},
    } as unknown as Storage;
    expect(writeVoiceNotepadDraft(draft(), full)).toBe(false);
  });
});
