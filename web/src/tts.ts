import {
  STREAMING_SPEECH_TTS_STATE_EVENT,
  STREAMING_SPEECH_TTS_STATUS,
} from '@shared/voice-recognition.js';
import { isNative } from './native.js';
import {
  getNativeSystemTts,
  type NativeSystemTts,
  type NativeTtsStateEvent,
  type NativeTtsVoiceQualityInfo,
} from './voice-recognition-backend.js';

export const TTS_AUTO_READ_STORAGE_KEY = 'imcodes_tts_auto_read';
export const TTS_SPEECH_RATE_STORAGE_KEY = 'imcodes_tts_rate';
export const TTS_DEFAULT_RATE = 1.1;
export const TTS_MIN_RATE = 0.5;
export const TTS_MAX_RATE = 2.0;
export const TTS_RATE_OPTIONS = [0.9, 1.0, 1.1, 1.25, 1.5] as const;
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
const KNOWN_FILE_EXT_PATTERN =
  'ts|tsx|js|jsx|mjs|cjs|mts|cts|json|css|scss|less|html|htm|md|mdx|yml|yaml|toml|lock|sh|zsh|bash|swift|java|kt|kts|py|rb|go|rs|c|cc|cpp|h|hpp|sql|xml|plist|gradle|properties|env|log|txt|svg|png|jpg|jpeg|webp|onnx|bin|entitlements';
const LINE_SUFFIX_PATTERN = '(?::\\d+(?::\\d+)?(?:-\\d+(?::\\d+)?)?|#L\\d+(?:-L?\\d+)?)?';
const TECH_PRODUCT_DOT_NAMES = /^(?:node|next|vue|nuxt|react|three|express|electron|ember|angular|backbone|chart|d3|reveal|highlight|popper|anime|tone|p5|alpine)\.js$/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function placeholderForLangTag(rawLang: string): string {
  const lower = rawLang.trim().replace('_', '-').toLowerCase();
  if (lower.startsWith('zh-tw') || lower.startsWith('zh-hk') || lower.startsWith('zh-mo') || lower.startsWith('zh-hant')) {
    return '相關文件';
  }
  if (lower.startsWith('zh')) return '相关文件';
  if (lower.startsWith('ja')) return '関連ファイル';
  if (lower.startsWith('ko')) return '관련 파일';
  if (lower.startsWith('es')) return 'archivo';
  if (lower.startsWith('ru')) return 'файл';
  return 'file';
}

function resolveFilePlaceholder(text: string, explicitLang?: string): string {
  if (explicitLang && explicitLang.trim()) {
    return placeholderForLangTag(explicitLang);
  }
  const docLang = (globalThis as { document?: { documentElement?: { lang?: string } } }).document?.documentElement?.lang ?? '';
  if (/[\u3040-\u30ff]/.test(text)) return '関連ファイル';
  if (/[\uac00-\ud7af\u1100-\u11ff]/.test(text)) return '관련 파일';
  if (/[\u4e00-\u9fff]/.test(text)) {
    return docLang.toLowerCase().startsWith('zh-tw') || docLang.toLowerCase().startsWith('zh-hk')
      ? '相關文件'
      : '相关文件';
  }
  if (/[\u0400-\u04ff]/.test(text)) return 'файл';
  if (docLang.trim()) return placeholderForLangTag(docLang);
  return 'file';
}

function isPauseTerminated(value: string): boolean {
  return /[。！？.!?;；:：，,、]$/.test(value.trim());
}

/**
 * Prepare Markdown prose for spoken playback: strip code blocks/markup,
 * fold technical file paths/IDs into a brief localized placeholder, and
 * smooth code operators for natural reading.
 */
export function prepareTextForTts(markdownText: string, lang?: string): string {
  if (!markdownText) return '';
  let text = markdownText.replace(/\r\n?/g, '\n');
  // Strip HTML comments (including internal markers) and closed/unclosed fenced blocks.
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/```[\s\S]*?```/g, '\n');
  text = text.replace(/~~~[\s\S]*?~~~/g, '\n');
  text = text.replace(/^[ \t]*(?:```|~~~)[\s\S]*$/gm, '');

  const filePlaceholder = resolveFilePlaceholder(text, lang);
  const escPlaceholder = escapeRegExp(filePlaceholder);

  // Convert images and file:// links before general links so local paths fold cleanly.
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  text = text.replace(/\[[^\]]+\]\((?:<file:\/\/[^>]+>|file:\/\/[^)\s]+)\)/gi, filePlaceholder);
  text = text.replace(/file:\/\/[^\s)\]>]+/gi, filePlaceholder);
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Remove autolinks, bare URLs, HTML tags, and long hex hashes/tokens.
  text = text.replace(/<https?:\/\/[^>]+>/gi, '');
  text = text.replace(/https?:\/\/\S+/gi, '');
  text = text.replace(/<[^>]+>/g, '');
  // Strip inline code backticks while preserving short inline code names.
  text = text.replace(/`([^`\n]+)`/g, '$1');
  // Strip Markdown headings, blockquotes, list markers (and task checkboxes), rules, and table dividers.
  text = text.replace(/^[ \t]*#{1,6}[ \t]+/gm, '');
  text = text.replace(/^[ \t]*(?:>[ \t]?)+/gm, '');
  text = text.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\]\[[ xX]\]|\[[ xX]\])?[ \t]*/gm, '');
  text = text.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '');
  text = text.replace(/^[ \t]*\|?(?:[ \t]*:?-{2,}:?[ \t]*\|)+[ \t]*$/gm, '');

  // Strip technical IDs and commit SHAs while keeping ordinary words and plain numbers intact.
  text = text.replace(/\b(?:tsk|deck|cb|msg)_[a-z0-9_]{4,}\b/gi, '');
  text = text.replace(/\b(?:0x)?[0-9a-fA-F]{7,40}\b/g, (match) => {
    const clean = match.startsWith('0x') || match.startsWith('0X') ? match.slice(2) : match;
    if (clean.length >= 16) return '';
    return /\d/.test(clean) && /[a-fA-F]/.test(clean) ? '' : match;
  });

  // Fold Windows paths, Unix absolute/relative paths, repo-relative paths, and filenames.
  text = text.replace(
    new RegExp(`[A-Za-z]:\\\\[^\\s"'\`<>|(){}\\[\\],;，。、；：]*[A-Za-z0-9_\\\\/-]${LINE_SUFFIX_PATTERN}`, 'g'),
    filePlaceholder,
  );
  text = text.replace(
    new RegExp(`(^|[\\s([{"'“‘:：,，、;；])(?:~\\/|\\/|\\.\\.?\\/)[A-Za-z0-9._-]+(?:\\/[A-Za-z0-9._-]+)*${LINE_SUFFIX_PATTERN}`, 'g'),
    `$1${filePlaceholder}`,
  );
  text = text.replace(
    new RegExp(
      `(^|[\\s([{"'“‘:：,，、;；])(?:[A-Za-z0-9._-]+(?:\\/[A-Za-z0-9._-]+){2,}|[A-Za-z0-9._-]+\\/[A-Za-z0-9._-]+\\.(?:${KNOWN_FILE_EXT_PATTERN}))${LINE_SUFFIX_PATTERN}(?=$|[\\s)\\]}>"'”’.,，。、;；:：!?！？])`,
      'gi',
    ),
    `$1${filePlaceholder}`,
  );
  text = text.replace(
    new RegExp(
      `(^|[\\s([{"'“‘:：,，、;；])([A-Za-z0-9_][A-Za-z0-9._-]*\\.(?:${KNOWN_FILE_EXT_PATTERN}))(${LINE_SUFFIX_PATTERN})(?=$|[\\s)\\]}>"'”’.,，。、;；:：!?！？])`,
      'gi',
    ),
    (full, prefix: string, filename: string) => {
      if (TECH_PRODUCT_DOT_NAMES.test(filename)) return full;
      return `${prefix}${filePlaceholder}`;
    },
  );

  // Smooth spoken operators and issue numbers before converting table pipes to commas.
  text = text.replace(/[ \t]*(?:->|=>|&&|\|\|)[ \t]*/g, ', ');
  text = text.replace(/::/g, ' ');
  text = text.replace(/(^|[\s([{"'“‘，,、;；:：])#(\d+\b)/g, '$1$2');
  text = text.replace(/\|/g, ', ');

  // Unwrap emphasis/strikethrough without mangling snake_case identifiers.
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  text = text.replace(/__([^_\n]+)__/g, '$1');
  text = text.replace(/~~([^~\n]+)~~/g, '$1');
  text = text.replace(/\*([^*\n]+)\*/g, '$1');
  text = text.replace(/(^|[\s([{"'“‘])_([^_\n]+)_(?=$|[\s)\].,!?;:"'”’])/g, '$1$2');

  // Collapse adjacent file placeholders connected by separators, strip empty brackets and dangling punctuation.
  const adjacentPlaceholderRe = new RegExp(
    `${escPlaceholder}(?:(?:[ \\t]*(?:[、,;；/&+]|和|与|及|\\band\\b|\\bor\\b)[ \\t]*|[ \\t]+)${escPlaceholder})+`,
    'gi',
  );
  text = text.replace(adjacentPlaceholderRe, filePlaceholder);
  text = text.replace(/\(\s*[,，;；:：\s]*\)/g, '');
  text = text.replace(/（\s*[,，;；:：\s]*）/g, '');
  text = text.replace(/\[\s*[,，;；:：\s]*\]/g, '');
  text = text.replace(/[ \t]+(?=[,，.。!！?？;；:：、])/g, '');
  text = text.replace(/,\s*(?:,\s*)+/g, ', ');

  // Collapse whitespace cleanly and drop pure file-list / empty-after-folding lines.
  const placeholderStripRe = new RegExp(escPlaceholder, 'g');
  const lines = text
    .split('\n')
    .map((line) => line.replace(/^[ \t]*[,，;；]+[ \t]*/, '').replace(/[ \t]*[,，;；]+[ \t]*$/, '').replace(/[ \t]{2,}/g, ' ').trim())
    .filter((line) => {
      if (!line) return false;
      const withoutPlaceholders = line
        .replace(placeholderStripRe, ' ')
        .replace(/\b(?:and|or)\b/gi, ' ')
        .replace(/[和与及]/g, ' ');
      return /[\p{L}\p{N}]/u.test(withoutPlaceholders);
    });

  const joined = lines.join('\n').trim();
  if (!joined || !/[\p{L}\p{N}]/u.test(joined)) {
    return '';
  }
  return joined;
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
    if (prev && prev.lang === lang) {
      const pausePunct = isPauseTerminated(prev.text)
        ? ''
        : (lang.startsWith('zh') || lang.startsWith('ja') ? '。' : '.');
      const nextText = `${prev.text}${pausePunct} ${sentence}`;
      if (nextText.length <= maxChunkChars) {
        prev.text = nextText;
        continue;
      }
    }
    segments.push({ text: sentence, lang });
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

export async function getNativeTtsVoiceQuality(lang?: string): Promise<NativeTtsVoiceQualityInfo | null> {
  if (!isNative()) return null;
  const nativeTts = getNativeSystemTts();
  if (!nativeTts || typeof nativeTts.getTtsVoiceQuality !== 'function') {
    return null;
  }
  try {
    return await nativeTts.getTtsVoiceQuality(lang ? { lang } : undefined);
  } catch {
    return null;
  }
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
  const cleaned = prepareTextForTts(text, options.lang);
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
