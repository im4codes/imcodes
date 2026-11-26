import { INLINE_PASTE_TEXT_CHAR_LIMIT } from './composer-inline-limit.js';

/**
 * Voice notepad: the crash-safe local draft and the message it becomes.
 *
 * Nothing here leaves the device. A draft lives in localStorage (not
 * sessionStorage: an OS kill or force-quit of the app must not take it with
 * it) under one key per session, and it stays there until the user either
 * sends it -- and the send is accepted -- or discards it and confirms. There
 * is no expiry: an unsent meeting transcript is the user's data, not a cache.
 */

/** How often a running notepad writes its transcript to the local draft. */
export const NOTEPAD_DRAFT_SAVE_INTERVAL_MS = 3000;

/**
 * Transcripts longer than this are uploaded as a Markdown file and referenced
 * from the message; shorter ones go inline as one ordinary message. The same
 * limit the composer already applies to pasted text, so a transcript is
 * treated exactly like the same text pasted in.
 */
export const NOTEPAD_INLINE_TRANSCRIPT_CHAR_LIMIT = INLINE_PASTE_TEXT_CHAR_LIMIT;

/** Bounds the per-segment timing record of a very long meeting. */
export const NOTEPAD_MAX_DRAFT_SEGMENTS = 5000;

const DRAFT_KEY_PREFIX = 'rcc_voice_notepad_draft_v1:';

/** One recognizer segment as it was committed, relative to the notepad start. */
export interface VoiceNotepadSegment {
  atMs: number;
  text: string;
}

export interface VoiceNotepadDraft {
  version: 1;
  /** Session the notepad was opened from; the draft is only offered there. */
  scope: string;
  /** The transcript as the user last saw it, edits included. */
  text: string;
  /** The summary instruction, once the user has edited it in review. */
  instruction?: string;
  segments: VoiceNotepadSegment[];
  startedAt: number;
  updatedAt: number;
}

export function voiceNotepadDraftKey(scope: string): string {
  return `${DRAFT_KEY_PREFIX}${scope}`;
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isSegment(value: unknown): value is VoiceNotepadSegment {
  const segment = value as Partial<VoiceNotepadSegment> | null;
  return !!segment
    && typeof segment.atMs === 'number' && Number.isFinite(segment.atMs)
    && typeof segment.text === 'string';
}

export function readVoiceNotepadDraft(
  scope: string,
  storage: Storage | null = defaultStorage(),
): VoiceNotepadDraft | null {
  if (!storage) return null;
  let parsed: unknown;
  try {
    const raw = storage.getItem(voiceNotepadDraftKey(scope));
    if (!raw) return null;
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const draft = parsed as Partial<VoiceNotepadDraft> | null;
  if (!draft || draft.version !== 1 || draft.scope !== scope
    || typeof draft.text !== 'string'
    || typeof draft.startedAt !== 'number' || typeof draft.updatedAt !== 'number'
    || !Array.isArray(draft.segments) || !draft.segments.every(isSegment)) {
    return null;
  }
  // A draft with no words in it is nothing to offer.
  if (!draft.text.trim()) return null;
  return {
    version: 1,
    scope,
    text: draft.text,
    ...(typeof draft.instruction === 'string' ? { instruction: draft.instruction } : {}),
    segments: draft.segments,
    startedAt: draft.startedAt,
    updatedAt: draft.updatedAt,
  };
}

/** False when the device refused the write (quota, private mode). */
export function writeVoiceNotepadDraft(
  draft: VoiceNotepadDraft,
  storage: Storage | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  const bounded: VoiceNotepadDraft = draft.segments.length > NOTEPAD_MAX_DRAFT_SEGMENTS
    ? { ...draft, segments: draft.segments.slice(-NOTEPAD_MAX_DRAFT_SEGMENTS) }
    : draft;
  try {
    storage.setItem(voiceNotepadDraftKey(draft.scope), JSON.stringify(bounded));
    return true;
  } catch {
    return false;
  }
}

export function deleteVoiceNotepadDraft(
  scope: string,
  storage: Storage | null = defaultStorage(),
): void {
  try {
    storage?.removeItem(voiceNotepadDraftKey(scope));
  } catch {
    /* nothing to delete */
  }
}

export function needsNotepadTranscriptAttachment(transcript: string): boolean {
  return transcript.length > NOTEPAD_INLINE_TRANSCRIPT_CHAR_LIMIT;
}

/** The single ordinary message a short transcript is sent as. */
export function buildNotepadInlineMessage(
  instruction: string,
  transcriptLabel: string,
  transcript: string,
): string {
  const head = instruction.trim();
  return head ? `${head}\n\n${transcriptLabel}\n\n${transcript}` : transcript;
}

export function buildNotepadTranscriptFileName(now = new Date()): string {
  return `voice-notepad-${now.toISOString().replace(/[:.]/g, '-')}.md`;
}

/** What the overlay asks the composer to send once the user confirms review. */
export interface VoiceNotepadSendRequest {
  instruction: string;
  transcript: string;
  /** Called once the send is accepted, including after a confirmation dialog. */
  onAccepted: () => void;
}

export type VoiceNotepadSendOutcome = 'accepted' | 'pending' | 'rejected';
