import {
  STREAMING_SPEECH_TTS_STATE_EVENT,
  STREAMING_SPEECH_TTS_STATUS,
} from '@shared/voice-recognition.js';
import { isNative } from './native.js';
import {
  getNativeSystemTts,
  type NativeSystemTts,
  type NativeTtsStateEvent,
} from './voice-recognition-backend.js';

export const TTS_AUTO_READ_STORAGE_KEY = 'imcodes_tts_auto_read';
export const TTS_SPEECH_RATE_STORAGE_KEY = 'imcodes_tts_rate';
export const TTS_DEFAULT_RATE = 1.0;
export const TTS_MIN_RATE = 0.5;
export const TTS_MAX_RATE = 2.0;
export const TTS_RATE_OPTIONS = [0.8, 1.0, 1.25, 1.5] as const;
export const TTS_MAX_CHUNK_CHARS = 1200;

export type TtsPlaybackStatus = 'idle' | 'speaking';

export interface TtsPlaybackState {
  status: TtsPlaybackStatus;
  activeMessageId: string | null;
  error: string | null;
}

export interface TtsSegment {
  text: string;
  lang: string;
}

export interface SpeakTextOptions {
  messageId?: string;
  lang?: string;
  rate?: number;
}

export interface SpeakTextResult {
  started: boolean;
  reason?: 'empty' | 'unsupported' | 'superseded' | 'error';
  error?: string;
}

let state: TtsPlaybackState = {
  status: 'idle',
  activeMessageId: null,
  error: null,
};

let playbackGeneration = 0;
let activeWebUtterance: SpeechSynthesisUtterance | null = null;
let nativeTtsBoundPlugin: NativeSystemTts | null = null;
let nativeTtsListenerHandle: { remove: () => Promise<void> } | null = null;
let nativeStateWaiter: ((event: NativeTtsStateEvent) => void) | null = null;

const stateListeners = new Set<(next: TtsPlaybackState) => void>();
const preferenceListeners = new Set<() => void>();

function notifyState(): void {
  const snapshot = { ...state };
  for (const listener of stateListeners) {
    try { listener(snapshot); } catch { /* ignore subscriber errors */ }
  }
}

function setState(next: TtsPlaybackState): void {
  if (
    state.status === next.status
    && state.activeMessageId === next.activeMessageId
    && state.error === next.error
  ) {
    return;
  }
  state = next;
  notifyState();
}

function notifyPreferences(): void {
  for (const listener of preferenceListeners) {
    try { listener(); } catch { /* ignore subscriber errors */ }
  }
}

export function getTtsState(): TtsPlaybackState {
  return { ...state };
}

export function subscribeTtsState(listener: (next: TtsPlaybackState) => void): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

export function subscribeTtsPreferences(listener: () => void): () => void {
  preferenceListeners.add(listener);
  return () => {
    preferenceListeners.delete(listener);
  };
}

export function clampTtsRate(rate: unknown): number {
  const num = typeof rate === 'number' ? rate : Number(rate);
  if (!Number.isFinite(num)) return TTS_DEFAULT_RATE;
  return Math.min(TTS_MAX_RATE, Math.max(TTS_MIN_RATE, num));
}

export function getTtsAutoReadEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(TTS_AUTO_READ_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setTtsAutoReadEnabled(enabled: boolean): void {
  try {
    globalThis.localStorage?.setItem(TTS_AUTO_READ_STORAGE_KEY, enabled ? '1' : '0');
  } catch { /* localStorage may be unavailable */ }
  notifyPreferences();
}

export function getTtsSpeechRate(): number {
  try {
    const raw = globalThis.localStorage?.getItem(TTS_SPEECH_RATE_STORAGE_KEY);
    if (!raw) return TTS_DEFAULT_RATE;
    return clampTtsRate(Number(raw));
  } catch {
    return TTS_DEFAULT_RATE;
  }
}

export function setTtsSpeechRate(rate: number): void {
  const clamped = clampTtsRate(rate);
  try {
    globalThis.localStorage?.setItem(TTS_SPEECH_RATE_STORAGE_KEY, String(clamped));
  } catch { /* localStorage may be unavailable */ }
  notifyPreferences();
}

/** Normalize short UI/system locale tags to BCP-47 speech locale tags. */
export function normalizeTtsLangTag(rawLang?: string | null): string {
  const raw = (rawLang ?? '').trim().replace(/_/g, '-');
  if (!raw) {
    const docLang = typeof document !== 'undefined' ? document.documentElement?.lang : '';
    const navLang = typeof navigator !== 'undefined' ? navigator.language : '';
    return normalizeTtsLangTag(docLang || navLang || 'en-US');
  }
  const lower = raw.toLowerCase();
  if (lower === 'en') return 'en-US';
  if (lower === 'zh' || lower === 'zh-cn' || lower === 'zh-hans') return 'zh-CN';
  if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-hant') return 'zh-TW';
  if (lower === 'ja') return 'ja-JP';
  if (lower === 'ko') return 'ko-KR';
  if (lower === 'es') return 'es-ES';
  if (lower === 'ru') return 'ru-RU';
  return raw;
}

/**
 * Strip fenced code blocks, Markdown syntax, URLs, and long hashes so system
 * TTS reads natural prose without speaking raw symbols aloud.
 */
export function prepareTextForTts(markdownText: string): string {
  if (!markdownText) return '';
  let text = markdownText.replace(/\r\n?/g, '\n');
  // Strip HTML comments (including internal markers) and closed/unclosed fenced blocks.
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/```[\s\S]*?```/g, '\n');
  text = text.replace(/~~~[\s\S]*?~~~/g, '\n');
  text = text.replace(/^[ \t]*(?:```|~~~)[\s\S]*$/gm, '');
  // Convert images and links to readable label text only.
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Remove autolinks, bare URLs, HTML tags, and long hex hashes/tokens.
  text = text.replace(/<https?:\/\/[^>]+>/gi, '');
  text = text.replace(/https?:\/\/\S+/gi, '');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/\b(?:0x)?[0-9a-fA-F]{16,}\b/g, '');
  // Strip inline code backticks while preserving short inline code names.
  text = text.replace(/`([^`\n]+)`/g, '$1');
  // Strip Markdown headings, blockquotes, list markers, rules, and table dividers.
  text = text.replace(/^[ \t]*#{1,6}[ \t]+/gm, '');
  text = text.replace(/^[ \t]*(?:>[ \t]?)+/gm, '');
  text = text.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '');
  text = text.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '');
  text = text.replace(/^[ \t]*\|?(?:[ \t]*:?-{2,}:?[ \t]*\|)+[ \t]*$/gm, '');
  text = text.replace(/\|/g, ', ');
  // Unwrap emphasis/strikethrough without mangling snake_case identifiers.
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  text = text.replace(/__([^_\n]+)__/g, '$1');
  text = text.replace(/~~([^~\n]+)~~/g, '$1');
  text = text.replace(/\*([^*\n]+)\*/g, '$1');
  text = text.replace(/(^|[\s([{"'“‘])_([^_\n]+)_(?=$|[\s)\].,!?;:"'”’])/g, '$1$2');
  // Collapse whitespace cleanly.
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .trim();

  if (!text || !/[\p{L}\p{N}]/u.test(text)) {
    return '';
  }
  return text;
}

function detectSegmentLang(text: string, fallbackLang: string): string {
  if (/[\u3040-\u30ff]/.test(text)) return 'ja-JP';
  if (/[\uac00-\ud7af\u1100-\u11ff]/.test(text)) return 'ko-KR';
  if (/[\u4e00-\u9fff]/.test(text)) {
    return fallbackLang.toLowerCase().startsWith('zh-tw') || fallbackLang.toLowerCase().startsWith('zh-hk')
      ? 'zh-TW'
      : 'zh-CN';
  }
  if (/[\u0400-\u04ff]/.test(text)) return 'ru-RU';
  if (/[a-zA-Z]/.test(text)) {
    return fallbackLang.toLowerCase().startsWith('es') ? 'es-ES' : 'en-US';
  }
  return fallbackLang;
}

function splitOverlongSentence(sentence: string, maxChars: number): string[] {
  const parts: string[] = [];
  let cursor = 0;
  const trimmed = sentence.trim();
  while (cursor < trimmed.length) {
    if (trimmed.length - cursor <= maxChars) {
      const tail = trimmed.slice(cursor).trim();
      if (tail) parts.push(tail);
      break;
    }
    const end = cursor + maxChars;
    let splitAt = -1;
    for (let i = end; i > cursor + Math.floor(maxChars / 3); i--) {
      const ch = trimmed[i - 1];
      if (ch === '，' || ch === ',' || ch === '、' || ch === ';' || ch === '；' || ch === ' ') {
        splitAt = i;
        break;
      }
    }
    if (splitAt === -1 || splitAt <= cursor) splitAt = end;
    const chunk = trimmed.slice(cursor, splitAt).trim();
    if (chunk) parts.push(chunk);
    cursor = splitAt;
    while (cursor < trimmed.length && trimmed[cursor] === ' ') cursor++;
  }
  return parts;
}

/**
 * Split cleaned prose into sentence-aligned segments tagged with BCP-47
 * language codes and capped at TTS_MAX_CHUNK_CHARS per chunk.
 */
export function segmentTextForTts(text: string, fallbackLang?: string, maxChunkChars = TTS_MAX_CHUNK_CHARS): TtsSegment[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const normalizedFallback = normalizeTtsLangTag(fallbackLang);
  const lines = trimmed.split(/\n+/);
  const rawSentences: string[] = [];

  for (const line of lines) {
    const cleanLine = line.trim();
    if (!cleanLine) continue;
    const sentences = cleanLine.split(/(?<=[。！？.!?；;])\s+/);
    for (const s of sentences) {
      const piece = s.trim();
      if (!piece) continue;
      if (piece.length <= maxChunkChars) {
        rawSentences.push(piece);
      } else {
        rawSentences.push(...splitOverlongSentence(piece, maxChunkChars));
      }
    }
  }

  const segments: TtsSegment[] = [];
  for (const sentence of rawSentences) {
    const lang = detectSegmentLang(sentence, normalizedFallback);
    const prev = segments[segments.length - 1];
    if (prev && prev.lang === lang && prev.text.length + 1 + sentence.length <= maxChunkChars) {
      prev.text = `${prev.text} ${sentence}`;
    } else {
      segments.push({ text: sentence, lang });
    }
  }
  return segments;
}

function cancelWebSpeechSynthesis(): void {
  try {
    (globalThis as { speechSynthesis?: { cancel?: () => void } }).speechSynthesis?.cancel?.();
  } catch { /* unsupported */ }
}

function getWebSpeechSynthesis(): SpeechSynthesis | null {
  const synth = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  const ctor = (globalThis as { SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance }).SpeechSynthesisUtterance;
  if (!synth || typeof synth.speak !== 'function' || typeof ctor !== 'function') {
    return null;
  }
  return synth;
}

export function isTtsSupported(): boolean {
  if (isNative() && getNativeSystemTts()) return true;
  return getWebSpeechSynthesis() !== null;
}

export function isTtsSpeaking(): boolean {
  return state.status === 'speaking';
}

function isNativeUnimplementedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return typeof err === 'string' && /unimplemented|not implemented/i.test(err);
  }
  const record = err as { code?: unknown; message?: unknown };
  if (typeof record.code === 'string' && record.code.toUpperCase() === 'UNIMPLEMENTED') return true;
  if (typeof record.message === 'string' && /unimplemented|not implemented/i.test(record.message)) return true;
  return false;
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'System TTS playback failed';
}

async function ensureNativeTtsListener(plugin: NativeSystemTts): Promise<void> {
  if (nativeTtsBoundPlugin === plugin) return;
  if (nativeTtsListenerHandle) {
    try { await nativeTtsListenerHandle.remove(); } catch { /* ignore */ }
    nativeTtsListenerHandle = null;
  }
  nativeTtsBoundPlugin = plugin;
  if (typeof plugin.addListener !== 'function') return;
  try {
    nativeTtsListenerHandle = await plugin.addListener(STREAMING_SPEECH_TTS_STATE_EVENT, (event) => {
      if (nativeStateWaiter) {
        const waiter = nativeStateWaiter;
        waiter(event);
      } else if (event.status === STREAMING_SPEECH_TTS_STATUS.STOPPED) {
        setState({ status: 'idle', activeMessageId: null, error: null });
      } else if (event.status === STREAMING_SPEECH_TTS_STATUS.ERROR) {
        setState({ status: 'idle', activeMessageId: null, error: event.message ?? 'System TTS playback failed' });
      }
    });
  } catch {
    // Older/minimal plugin mocks may omit listener registration.
  }
}

function speakWithWebSpeech(
  segments: TtsSegment[],
  rate: number,
  gen: number,
  messageId: string | null,
): SpeakTextResult {
  const synth = getWebSpeechSynthesis();
  const UtteranceCtor = (globalThis as { SpeechSynthesisUtterance: typeof SpeechSynthesisUtterance }).SpeechSynthesisUtterance;
  if (!synth || !UtteranceCtor) {
    setState({ status: 'idle', activeMessageId: null, error: null });
    return { started: false, reason: 'unsupported' };
  }
  try {
    synth.cancel?.();
  } catch { /* ignore */ }

  setState({ status: 'speaking', activeMessageId: messageId, error: null });

  const speakAt = (index: number): void => {
    if (playbackGeneration !== gen) return;
    if (index >= segments.length) {
      activeWebUtterance = null;
      setState({ status: 'idle', activeMessageId: null, error: null });
      return;
    }
    const seg = segments[index];
    const utterance = new UtteranceCtor(seg.text);
    utterance.lang = seg.lang;
    utterance.rate = rate;
    utterance.onend = () => {
      if (playbackGeneration !== gen) return;
      speakAt(index + 1);
    };
    utterance.onerror = (event) => {
      if (playbackGeneration !== gen) return;
      activeWebUtterance = null;
      const errCode = (event as { error?: unknown } | undefined)?.error;
      if (errCode === 'interrupted' || errCode === 'canceled') {
        setState({ status: 'idle', activeMessageId: null, error: null });
        return;
      }
      setState({
        status: 'idle',
        activeMessageId: null,
        error: typeof errCode === 'string' && errCode ? errCode : 'System TTS playback failed',
      });
    };
    activeWebUtterance = utterance;
    synth.speak(utterance);
  };

  try {
    speakAt(0);
    return { started: true };
  } catch (err) {
    activeWebUtterance = null;
    const message = extractErrorMessage(err);
    setState({ status: 'idle', activeMessageId: null, error: message });
    return { started: false, reason: 'error', error: message };
  }
}

function waitForNativeSegmentCompletion(gen: number): Promise<NativeTtsStateEvent> {
  return new Promise((resolve) => {
    nativeStateWaiter = (event) => {
      if (playbackGeneration !== gen) {
        nativeStateWaiter = null;
        resolve({ status: STREAMING_SPEECH_TTS_STATUS.STOPPED });
        return;
      }
      if (event.status === STREAMING_SPEECH_TTS_STATUS.STARTED) return;
      nativeStateWaiter = null;
      resolve(event);
    };
  });
}

async function runNativeSegments(
  nativeTts: NativeSystemTts,
  segments: TtsSegment[],
  rate: number,
  gen: number,
  messageId: string | null,
): Promise<SpeakTextResult> {
  await ensureNativeTtsListener(nativeTts);
  if (playbackGeneration !== gen) {
    return { started: false, reason: 'superseded' };
  }

  const first = segments[0];
  let completionPromise = typeof nativeTts.addListener === 'function'
    ? waitForNativeSegmentCompletion(gen)
    : null;

  try {
    await nativeTts.speak({ text: first.text, lang: first.lang, rate });
  } catch (err) {
    nativeStateWaiter = null;
    if (playbackGeneration !== gen) {
      return { started: false, reason: 'superseded' };
    }
    if (isNativeUnimplementedError(err)) {
      return speakWithWebSpeech(segments, rate, gen, messageId);
    }
    const message = extractErrorMessage(err);
    setState({ status: 'idle', activeMessageId: null, error: message });
    return { started: false, reason: 'error', error: message };
  }

  if (playbackGeneration !== gen) {
    return { started: false, reason: 'superseded' };
  }

  if (completionPromise) {
    void (async () => {
      try {
        let result = await completionPromise!;
        for (let i = 1; i < segments.length; i++) {
          if (playbackGeneration !== gen || result.status === STREAMING_SPEECH_TTS_STATUS.ERROR) break;
          completionPromise = waitForNativeSegmentCompletion(gen);
          await nativeTts.speak({ text: segments[i].text, lang: segments[i].lang, rate });
          result = await completionPromise;
        }
        if (playbackGeneration === gen) {
          setState({
            status: 'idle',
            activeMessageId: null,
            error: result.status === STREAMING_SPEECH_TTS_STATUS.ERROR
              ? (result.message ?? 'System TTS playback failed')
              : null,
          });
        }
      } catch (err) {
        if (playbackGeneration === gen) {
          nativeStateWaiter = null;
          setState({ status: 'idle', activeMessageId: null, error: extractErrorMessage(err) });
        }
      }
    })();
  }

  return { started: true };
}

/**
 * Clean Markdown prose, split into language-tagged segments, and speak through
 * native system TTS (with Web speechSynthesis fallback for desktop/older shells).
 */
export async function speakText(text: string, options: SpeakTextOptions = {}): Promise<SpeakTextResult> {
  const cleaned = prepareTextForTts(text);
  if (!cleaned) {
    return { started: false, reason: 'empty' };
  }
  const segments = segmentTextForTts(cleaned, options.lang);
  if (segments.length === 0) {
    return { started: false, reason: 'empty' };
  }

  const gen = ++playbackGeneration;
  const messageId = options.messageId ?? null;
  const rate = clampTtsRate(options.rate ?? getTtsSpeechRate());
  nativeStateWaiter = null;
  clearActiveWebUtterance();
  cancelWebSpeechSynthesis();

  const nativeTts = isNative() ? getNativeSystemTts() : null;
  if (nativeTts) {
    setState({ status: 'speaking', activeMessageId: messageId, error: null });
    return runNativeSegments(nativeTts, segments, rate, gen, messageId);
  }

  return speakWithWebSpeech(segments, rate, gen, messageId);
}

function clearActiveWebUtterance(): void {
  if (activeWebUtterance) {
    activeWebUtterance.onend = null;
    activeWebUtterance.onerror = null;
    activeWebUtterance = null;
  }
}

/** Stop any active Web or native system TTS playback and reset playback state. */
export async function stopSpeaking(): Promise<void> {
  playbackGeneration += 1;
  clearActiveWebUtterance();
  const pendingWaiter = nativeStateWaiter;
  nativeStateWaiter = null;
  if (pendingWaiter) {
    pendingWaiter({ status: STREAMING_SPEECH_TTS_STATUS.STOPPED });
  }
  setState({ status: 'idle', activeMessageId: null, error: null });
  cancelWebSpeechSynthesis();
  const nativeTts = isNative() ? getNativeSystemTts() : null;
  if (nativeTts) {
    try {
      await nativeTts.stopSpeaking();
    } catch { /* ignore */ }
  }
}

export async function __resetTtsForTests(): Promise<void> {
  playbackGeneration += 1;
  clearActiveWebUtterance();
  nativeStateWaiter = null;
  if (nativeTtsListenerHandle) {
    try { await nativeTtsListenerHandle.remove(); } catch { /* ignore */ }
    nativeTtsListenerHandle = null;
  }
  nativeTtsBoundPlugin = null;
  state = { status: 'idle', activeMessageId: null, error: null };
  stateListeners.clear();
  preferenceListeners.clear();
}
