/**
 * VoiceInput — speech recognition wrapper.
 * Native Android/iOS use our shared offline streaming bridge when installed;
 * older shells retain the existing @capgo platform recognizer. On desktop browsers (Chrome / Edge / Safari) it falls back to
 * the Web Speech API (window.SpeechRecognition / webkitSpeechRecognition).
 * Firefox has no Web Speech API, so the button is hidden there.
 * Both paths share the same callback contract: onResult receives the FULL
 * cumulative transcript of the current session each time (the overlay replaces
 * the prior voice segment with it), plus an isFinal flag.
 */
import {
  getNativeSpeechRecognition,
  getPlatformFallbackSpeechRecognition,
  type NativeSpeechRecognition,
} from '../voice-recognition-backend.js';
import type { PluginListenerHandle } from '@capacitor/core';

/** Resolve the user's active UI language preference first, then fall back to system navigator.language. */
function resolvePreferredLanguageTag(preferredLang?: string): string {
  if (typeof preferredLang === 'string' && preferredLang.trim()) {
    return preferredLang.trim();
  }
  try {
    const saved = globalThis.localStorage?.getItem('imcodes_lang');
    if (typeof saved === 'string' && saved.trim()) {
      return saved.trim();
    }
  } catch { /* localStorage may be unavailable in restricted contexts */ }
  const docLang = typeof document !== 'undefined' ? document.documentElement?.lang?.trim() : '';
  if (docLang) return docLang;
  return (typeof navigator !== 'undefined' && navigator.language) ? navigator.language : 'en-US';
}

/** Native (Capacitor) speech-recognition locale tags. */
export function pickLocale(preferredLang?: string): string {
  const lang = resolvePreferredLanguageTag(preferredLang).toLowerCase();
  if (lang.startsWith('zh')) {
    return lang.includes('tw') || lang.includes('hk') || lang.includes('hant') ? 'zh-Hant' : 'zh-Hans';
  }
  if (lang.startsWith('ja')) return 'ja-JP';
  if (lang.startsWith('ko')) return 'ko-KR';
  if (lang.startsWith('es')) return 'es-ES';
  if (lang.startsWith('ru')) return 'ru-RU';
  return 'en-US';
}

/** Web Speech API locale tags (BCP-47, region-specific). */
export function pickWebLocale(preferredLang?: string): string {
  const lang = resolvePreferredLanguageTag(preferredLang).toLowerCase();
  if (lang.startsWith('zh')) {
    return lang.includes('tw') || lang.includes('hk') || lang.includes('hant') ? 'zh-TW' : 'zh-CN';
  }
  if (lang.startsWith('ja')) return 'ja-JP';
  if (lang.startsWith('ko')) return 'ko-KR';
  if (lang.startsWith('es')) return 'es-ES';
  if (lang.startsWith('ru')) return 'ru-RU';
  return 'en-US';
}

function isNative(): boolean {
  return !!(globalThis as any).Capacitor?.isNativePlatform?.();
}

function getWebSpeechCtor(): any {
  const g = globalThis as any;
  return g.SpeechRecognition || g.webkitSpeechRecognition || null;
}

function isWebSpeechAvailable(): boolean {
  return !isNative() && !!getWebSpeechCtor();
}

export function isAvailable(): boolean {
  return isNative() || isWebSpeechAvailable();
}

interface CaptureOwner {
  id: number;
  retired: boolean;
  onResult: ((text: string, isFinal: boolean) => void) | null;
  onListeningChange: ((listening: boolean) => void) | null;
  onError: ((error: string) => void) | null;
}

interface NativeSession {
  generation: number;
  owner: CaptureOwner;
  recognition: NativeSpeechRecognition;
  text: string | null;
  final: boolean;
  aborted: boolean;
  retired: boolean;
  stopStarted: boolean;
  handles: PluginListenerHandle[];
}

interface PrewarmCacheEntry {
  primary: NativeSpeechRecognition;
  effective: NativeSpeechRecognition;
  checkedAt: number;
  permissionGranted: boolean;
  available: boolean;
}

const PREWARM_CACHE_TTL_MS = 15_000;

interface WebSession {
  generation: number;
  owner: CaptureOwner;
  rec: any;
  retired: boolean;
  ended: boolean;
  primed: boolean;
  deferAudioPause: boolean;
  captureStarted: boolean;
  lastText: string;
  emittedFinal: boolean;
  earlyError: string | null;
}

interface PrimedWebOutcome {
  generation: number;
  error: string | null;
  text: string | null;
  endedWithCapture: boolean;
}

let _listening = false;
let _generation = 0;
let _ownerSeq = 0;
let _intentSeq = 0;
let _lastStopIntent = 0;
let _pendingStart: { promise: Promise<boolean>; generation: number; session: NativeSession } | null = null;
let _pendingStop: Promise<void> | null = null;
let _nativeSession: NativeSession | null = null;
let _activeOwner: CaptureOwner | null = null;
let _prewarmCache: PrewarmCacheEntry | null = null;
let _prewarmInFlight: { promise: Promise<void>; requestPermission: boolean } | null = null;
let _onLevel: ((level: number) => void) | null = null;
let _onError: ((error: string) => void) | null = null;
let _lastError: string | null = null;

// --- Web Speech API fallback state (desktop & mobile browsers) ---
let _webSession: WebSession | null = null;
let _primedOutcome: PrimedWebOutcome | null = null;
let _webDrainCancel: (() => void) | null = null;
let _webStream: MediaStream | null = null;
let _webAudioCtx: AudioContext | null = null;
let _webLevelRAF: number | null = null;

function createCaptureOwner(
  onResult: (text: string, isFinal: boolean) => void,
  onListeningChange?: (listening: boolean) => void,
  onError?: (error: string) => void,
): CaptureOwner {
  return {
    id: ++_ownerSeq,
    retired: false,
    onResult,
    onListeningChange: onListeningChange ?? null,
    onError: onError ?? null,
  };
}

function isOwnerCurrent(owner: CaptureOwner | null): boolean {
  return !!owner && !owner.retired && _activeOwner === owner;
}

function setOwnerListening(owner: CaptureOwner | null, next: boolean): void {
  if (!isOwnerCurrent(owner)) return;
  _listening = next;
  owner!.onListeningChange?.(next);
}

function emitOwnerResult(owner: CaptureOwner | null, text: string, isFinal: boolean): void {
  if (!isOwnerCurrent(owner)) return;
  owner!.onResult?.(text, isFinal);
}

function reportOwnerError(owner: CaptureOwner | null, error: string): void {
  _prewarmCache = null;
  if (!isOwnerCurrent(owner)) return;
  _lastError = error;
  (owner!.onError ?? _onError)?.(error);
}

function retireOwner(owner: CaptureOwner | null): void {
  if (!owner || owner.retired) return;
  if (_activeOwner === owner) {
    _listening = false;
    _activeOwner = null;
  }
  owner.retired = true;
  owner.onResult = null;
  owner.onListeningChange = null;
  owner.onError = null;
}

function claimActiveOwner(nextOwner: CaptureOwner): void {
  if (_activeOwner && _activeOwner !== nextOwner) {
    // Coalescing updates callbacks without dropping active capture state unless explicitly retired.
    _activeOwner.retired = true;
    _activeOwner.onResult = null;
    _activeOwner.onListeningChange = null;
    _activeOwner.onError = null;
  }
  _activeOwner = nextOwner;
}

async function removeHandle(handle: PluginListenerHandle | null): Promise<void> {
  if (!handle) return;
  try {
    await handle.remove();
  } catch { /* best effort listener cleanup */ }
}

async function cleanupSessionListeners(session: NativeSession | null): Promise<void> {
  if (!session || session.handles.length === 0) return;
  const handles = session.handles.splice(0);
  await Promise.all(handles.map((handle) => removeHandle(handle)));
}

/** Pause app-owned playback before activating a recording audio session. This
 * avoids a simultaneous playback/record route transition; never change the
 * system volume or attempt to control other apps. Resumption is user-owned. */
function pauseBackgroundAudio(): void {
  for (const media of document.querySelectorAll<HTMLMediaElement>('audio, video')) {
    try { if (!media.paused) media.pause(); } catch { /* best effort */ }
  }
  try { globalThis.speechSynthesis?.cancel(); } catch { /* unsupported */ }
}

async function attachSessionListeners(
  recognition: NativeSpeechRecognition,
  session: NativeSession,
): Promise<boolean> {
  const { generation } = session;
  let aborted = false;

  const isSessionLive = (): boolean =>
    !aborted
    && !session.retired
    && !session.aborted
    && !session.owner.retired
    && _nativeSession === session;

  const registrations: Array<readonly [any, (data: any) => void]> = [
    ['partialResults', (data: { matches?: string[]; isFinal?: boolean }) => {
      if (!isSessionLive() || session.final || !data.matches?.length) return;
      const text = data.matches[0];
      const final = data.isFinal === true;
      // Native owns committed + unfixed text and emits a cumulative snapshot,
      // not an append-only delta. Corrections may shorten the unfixed tail.
      // Keep this listener through stop ACK so its final short tail is retained.
      if (typeof text !== 'string' || (!final && session.text === text)) return;
      session.text = text;
      session.final = final;
      emitOwnerResult(session.owner, text, final);
    }],
    // Audio level listener (emitted from native at ~15-20fps; ignore after stop advances generation)
    ['audioLevel', (data: any) => {
      if (!isSessionLive() || generation !== _generation) return;
      _onLevel?.(data.level ?? 0);
    }],
    ['listeningState', (data: { status?: string }) => {
      if (!isSessionLive() || generation !== _generation) return;
      if (data.status === 'started') {
        setOwnerListening(session.owner, true);
        return;
      }
      // Serialize cleanup with the next start; a late stopped event from this
      // recognizer cannot tear down a new language session.
      void stopListening();
    }],
    ['recognitionError', (data: any) => {
      if (!isSessionLive()) return;
      const message = typeof data?.message === 'string' && data.message.trim()
        ? data.message.trim()
        : 'Speech recognition error';
      console.warn('[voice] recognitionError:', message);
      reportOwnerError(session.owner, message);
      void stopListening();
    }],
  ];

  try {
    const outcomes = await Promise.all(
      registrations.map(async ([eventName, handler]) => {
        const handle = await recognition.addListener(eventName, handler);
        if (!isSessionLive() || generation !== _generation) {
          await removeHandle(handle);
          return false;
        }
        session.handles.push(handle);
        return true;
      }),
    );

    if (outcomes.some((ok) => !ok) || !isSessionLive() || generation !== _generation) {
      aborted = true;
      await cleanupSessionListeners(session);
      return false;
    }

    return true;
  } catch (err) {
    aborted = true;
    await cleanupSessionListeners(session);
    throw err;
  }
}

async function resolveUsableFallbackRecognizer(
  primary: NativeSpeechRecognition,
  requestPermission = true,
): Promise<NativeSpeechRecognition | null> {
  const fallback = getPlatformFallbackSpeechRecognition();
  if (!fallback || fallback === primary || typeof fallback.available !== 'function') return null;
  try {
    const checkPerms = (
      fallback as NativeSpeechRecognition & {
        checkPermissions?: () => Promise<{ speechRecognition?: string }>;
      }
    ).checkPermissions;
    let granted = false;
    if (typeof checkPerms === 'function') {
      const checked = await checkPerms().catch(() => ({ speechRecognition: undefined }));
      granted = checked?.speechRecognition === 'granted';
    }
    if (!granted && !requestPermission) return null;
    const [perms, avail] = await Promise.all([
      granted
        ? Promise.resolve({ speechRecognition: 'granted' })
        : (typeof fallback.requestPermissions === 'function'
            ? fallback.requestPermissions()
            : Promise.resolve({ speechRecognition: 'granted' })),
      fallback.available(),
    ]);
    if (perms?.speechRecognition !== 'granted') return null;
    return avail?.available ? fallback : null;
  } catch {
    return null;
  }
}

function getFreshPrewarmCache(primary: NativeSpeechRecognition): PrewarmCacheEntry | null {
  if (!_prewarmCache) return null;
  if (
    _prewarmCache.primary !== primary
    || Date.now() - _prewarmCache.checkedAt > PREWARM_CACHE_TTL_MS
  ) {
    _prewarmCache = null;
    return null;
  }
  return _prewarmCache;
}

/** Pre-warm native speech permissions and recognizer availability so hold-to-talk
 * starts without an extra IPC permission/availability roundtrip on finger down.
 * Idempotent and deduplicated across concurrent callers; never throws. */
export async function prewarm(options?: { requestPermission?: boolean }): Promise<void> {
  if (!isNative()) return;
  const requestPermission = options?.requestPermission !== false;
  let recognition: NativeSpeechRecognition;
  try {
    recognition = getNativeSpeechRecognition();
  } catch {
    return;
  }

  const cached = getFreshPrewarmCache(recognition);
  if (cached && (cached.permissionGranted || !requestPermission)) {
    return;
  }

  if (_prewarmInFlight) {
    const shouldAwaitOnly = _prewarmInFlight.requestPermission || !requestPermission;
    await _prewarmInFlight.promise;
    if (shouldAwaitOnly) return;
    const afterWait = getFreshPrewarmCache(recognition);
    if (afterWait && afterWait.permissionGranted) return;
  }

  const runPromise = (async () => {
    try {
      const checkPerms = (
        recognition as NativeSpeechRecognition & {
          checkPermissions?: () => Promise<{ speechRecognition?: string }>;
        }
      ).checkPermissions;

      let permissionGranted = false;
      if (typeof checkPerms === 'function') {
        const checked = await checkPerms().catch(() => ({ speechRecognition: undefined }));
        permissionGranted = checked?.speechRecognition === 'granted';
      }

      if (!permissionGranted && requestPermission) {
        const perms = await recognition.requestPermissions().catch(() => ({ speechRecognition: 'denied' }));
        permissionGranted = perms?.speechRecognition === 'granted';
        if (!permissionGranted) {
          _prewarmCache = null;
          return;
        }
      }

      const available = await recognition.available().catch(() => ({ available: false }));
      let effective: NativeSpeechRecognition | null = available?.available ? recognition : null;
      if (!effective && (permissionGranted || requestPermission)) {
        effective = await resolveUsableFallbackRecognizer(recognition, requestPermission);
        if (effective) {
          permissionGranted = true;
        }
      }

      if (!effective) {
        _prewarmCache = null;
        return;
      }

      _prewarmCache = {
        primary: recognition,
        effective,
        checkedAt: Date.now(),
        permissionGranted,
        available: true,
      };
    } catch {
      _prewarmCache = null;
    }
  })();

  const entry = { promise: runPromise, requestPermission };
  _prewarmInFlight = entry;
  try {
    await runPromise;
  } finally {
    if (_prewarmInFlight === entry) {
      _prewarmInFlight = null;
    }
  }
}

async function startListeningInternal(session: NativeSession): Promise<boolean> {
  const { generation } = session;
  let recognition = session.recognition;
  _lastError = null;

  const isSessionStarting = (): boolean =>
    generation === _generation
    && !session.retired
    && !session.aborted
    && !session.owner.retired;

  const prevSession = _nativeSession;
  if (!isSessionStarting()) return false;
  if (prevSession && prevSession !== session) {
    prevSession.retired = true;
    _nativeSession = null;
    await cleanupSessionListeners(prevSession);
    if (!isSessionStarting()) return false;
  }
  _nativeSession = session;

  try {
    if (!getFreshPrewarmCache(recognition) && _prewarmInFlight) {
      await _prewarmInFlight.promise;
      if (!isSessionStarting()) {
        await cleanupSessionListeners(session);
        if (_nativeSession === session) _nativeSession = null;
        return false;
      }
    }

    const prewarmed = getFreshPrewarmCache(recognition);
    if (prewarmed && prewarmed.permissionGranted && prewarmed.available) {
      recognition = prewarmed.effective;
      session.recognition = prewarmed.effective;
    } else if (prewarmed && prewarmed.available) {
      const perms = await recognition.requestPermissions();
      if (!isSessionStarting()) {
        await cleanupSessionListeners(session);
        if (_nativeSession === session) _nativeSession = null;
        return false;
      }
      if (perms.speechRecognition !== 'granted') {
        console.warn('[voice] microphone permission denied');
        reportOwnerError(session.owner, 'permission_denied');
        session.retired = true;
        if (_nativeSession === session) _nativeSession = null;
        retireOwner(session.owner);
        return false;
      }
      prewarmed.permissionGranted = true;
      recognition = prewarmed.effective;
      session.recognition = prewarmed.effective;
    } else {
      const [perms, available] = await Promise.all([
        recognition.requestPermissions(),
        recognition.available().catch(() => ({ available: false })),
      ]);
      if (!isSessionStarting()) {
        await cleanupSessionListeners(session);
        if (_nativeSession === session) _nativeSession = null;
        return false;
      }
      if (perms.speechRecognition !== 'granted') {
        console.warn('[voice] microphone permission denied');
        reportOwnerError(session.owner, 'permission_denied');
        session.retired = true;
        if (_nativeSession === session) _nativeSession = null;
        retireOwner(session.owner);
        return false;
      }
      if (!available?.available) {
        const fallback = await resolveUsableFallbackRecognizer(recognition);
        if (!isSessionStarting()) {
          await cleanupSessionListeners(session);
          if (_nativeSession === session) _nativeSession = null;
          return false;
        }
        if (fallback) {
          console.warn('[voice] custom offline speech unavailable, falling back to platform recognizer');
          recognition = fallback;
          session.recognition = fallback;
        } else {
          console.warn('[voice] speech recognition unavailable');
          reportOwnerError(session.owner, 'Offline speech model unavailable');
          session.retired = true;
          if (_nativeSession === session) _nativeSession = null;
          retireOwner(session.owner);
          return false;
        }
      }
    }

    const attached = await attachSessionListeners(recognition, session);
    if (!attached || !isSessionStarting() || _nativeSession !== session) {
      await cleanupSessionListeners(session);
      if (_nativeSession === session) _nativeSession = null;
      return false;
    }

    const locale = pickLocale();
    pauseBackgroundAudio();
    try {
      await recognition.start({
        language: locale,
        partialResults: true,
        popup: false,
        addPunctuation: true,
      });
    } catch (startErr) {
      _prewarmCache = null;
      if (!isSessionStarting()) throw startErr;
      const startMsg = startErr instanceof Error ? startErr.message : String(startErr ?? '');
      if (!/permission|denied|not allowed/i.test(startMsg)) {
        const fallback = await resolveUsableFallbackRecognizer(recognition);
        if (fallback && isSessionStarting()) {
          console.warn('[voice] custom offline speech start failed, falling back to platform recognizer:', startMsg);
          await cleanupSessionListeners(session);
          recognition = fallback;
          session.recognition = fallback;
          const fallbackAttached = await attachSessionListeners(recognition, session);
          if (!fallbackAttached || !isSessionStarting() || _nativeSession !== session) {
            await cleanupSessionListeners(session);
            if (_nativeSession === session) _nativeSession = null;
            return false;
          }
          await recognition.start({
            language: locale,
            partialResults: true,
            popup: false,
            addPunctuation: true,
          });
        } else {
          throw startErr;
        }
      } else {
        throw startErr;
      }
    }

    if (!isSessionStarting()) {
      // Only stop native capture if this session wasn't already aborted/stopped and no newer session owns or is starting the shared plugin.
      if (!session.stopStarted && !_nativeSession && !_pendingStart) {
        session.stopStarted = true;
        try {
          await recognition.stop();
        } catch { /* stale start cleanup */ }
      }
      session.retired = true;
      await cleanupSessionListeners(session);
      if (_nativeSession === session) _nativeSession = null;
      return false;
    }

    setOwnerListening(session.owner, true);
    return true;
  } catch (err) {
    console.warn('[voice] start failed:', err);
    if (isSessionStarting()) {
      const msg = err instanceof Error ? err.message : String(err ?? 'Failed to start speech recognition');
      reportOwnerError(session.owner, /permission|denied|not allowed/i.test(msg) ? 'permission_denied' : msg);
      setOwnerListening(session.owner, false);
      retireOwner(session.owner);
    }
    session.retired = true;
    await cleanupSessionListeners(session);
    if (_nativeSession === session) _nativeSession = null;
    return false;
  }
}

// --- Web Speech API fallback (desktop browsers) ---

function stopWebLevelMeter(): void {
  if (_webLevelRAF != null) {
    cancelAnimationFrame(_webLevelRAF);
    _webLevelRAF = null;
  }
  if (_webStream) {
    _webStream.getTracks().forEach((t) => t.stop());
    _webStream = null;
  }
  if (_webAudioCtx) {
    try { void _webAudioCtx.close(); } catch { /* already closed */ }
    _webAudioCtx = null;
  }
}

/** Best-effort waveform levels via Web Audio. Failure must not break recognition. */
function shouldSkipWebLevelMeter(): boolean {
  // Touch-capable browsers (including iPad Safari "Request Desktop Website" and
  // Android Chrome "Desktop site" where UA omits Mobile/iPad tokens) share an
  // exclusive mic capture route with Web SpeechRecognition.
  return typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 0;
}

async function startWebLevelMeter(generation: number): Promise<void> {
  // Transcript ownership intentionally survives Stop until final/onend, but
  // microphone/RAF ownership ends immediately when capture stops.
  const isCapturing = (): boolean => generation === _generation && _listening;
  try {
    if (shouldSkipWebLevelMeter()) return;
    if (!isCapturing() || !navigator.mediaDevices?.getUserMedia) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!isCapturing()) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    _webStream = stream;
    const AC = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext;
    if (!AC) return;
    const ctx: AudioContext = new AC();
    _webAudioCtx = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = (): void => {
      if (!isCapturing()) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      _onLevel?.(Math.min(1, rms * 3));
      if (isCapturing()) _webLevelRAF = requestAnimationFrame(tick);
    };
    _webLevelRAF = requestAnimationFrame(tick);
  } catch { /* no level meter; recognition still works */ }
}

function clearWebRecHandlers(rec: any): void {
  if (!rec) return;
  rec.onstart = null;
  rec.onaudiostart = null;
  rec.onend = null;
  rec.onresult = null;
  rec.onerror = null;
}

function startWebListening(
  owner: CaptureOwner,
  options?: { primed?: boolean; deferAudioPause?: boolean },
): boolean {
  const primed = options?.primed === true;
  const deferAudioPause = options?.deferAudioPause === true;
  const Ctor = getWebSpeechCtor();
  if (!Ctor) {
    if (!primed) {
      reportOwnerError(owner, 'Speech recognition is not available');
      retireOwner(owner);
    }
    return false;
  }
  _lastError = null;
  _primedOutcome = null;

  // Tear down any prior instance (and any pending drain timer) so a fresh start never hits InvalidStateError.
  _webDrainCancel?.();
  _webDrainCancel = null;
  if (_webSession) {
    _webSession.retired = true;
    const prevRec = _webSession.rec;
    _webSession = null;
    clearWebRecHandlers(prevRec);
    try {
      prevRec.abort();
    } catch { /* best effort */ }
  }
  stopWebLevelMeter();

  const generation = ++_generation;
  try {
    const rec = new Ctor();
    const session: WebSession = {
      generation,
      owner,
      rec,
      retired: false,
      ended: false,
      primed,
      deferAudioPause,
      captureStarted: false,
      lastText: '',
      emittedFinal: false,
      earlyError: null,
    };
    const confirmWebCapture = (): void => {
      if (session.retired || generation !== _generation || !isOwnerCurrent(session.owner)) return;
      if (session.captureStarted) return;
      session.captureStarted = true;
      setOwnerListening(session.owner, true);
      if (!session.primed) {
        void startWebLevelMeter(generation);
      }
    };
    rec.lang = pickWebLocale();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onstart = confirmWebCapture;
    rec.onaudiostart = confirmWebCapture;
    rec.onresult = (event: any): void => {
      if (session.retired || generation !== _generation || !isOwnerCurrent(session.owner)) return;
      if (!event?.results?.length) return;
      confirmWebCapture();
      let txt = '';
      for (let i = 0; i < event.results.length; i++) {
        txt += event.results[i][0]?.transcript ?? '';
      }
      const trimmed = txt.trim();
      const last = event.results[event.results.length - 1];
      const isFinal = !!last?.isFinal;
      session.lastText = trimmed;
      session.emittedFinal = isFinal;
      emitOwnerResult(session.owner, trimmed, isFinal);
    };
    rec.onerror = (e: any): void => {
      // 'no-speech' / 'aborted' are routine; only surface real failures.
      if (e?.error && e.error !== 'no-speech' && e.error !== 'aborted') {
        console.warn('[voice] web speech error:', e.error);
        if (!session.retired && generation === _generation && isOwnerCurrent(session.owner)) {
          const errStr = String(e.error);
          const mapped = /not-allowed|service-not-allowed|permission/i.test(errStr) ? 'permission_denied' : errStr;
          if (session.primed) {
            session.earlyError = mapped;
            session.ended = true;
            session.retired = true;
            clearWebRecHandlers(rec);
            if (_webSession === session) _webSession = null;
            _generation++;
            _primedOutcome = { generation: _generation, error: mapped, text: null, endedWithCapture: false };
            retireOwner(session.owner);
            stopWebLevelMeter();
            try { rec.abort?.(); } catch { /* already ended */ }
            return;
          }
          reportOwnerError(session.owner, mapped);
          void stopListening();
        }
      }
    };
    rec.onend = (): void => {
      if (session.retired || generation !== _generation || !isOwnerCurrent(session.owner)) return;
      if (!session.captureStarted) {
        const err = session.earlyError ?? _lastError ?? 'permission_denied';
        session.ended = true;
        session.retired = true;
        clearWebRecHandlers(rec);
        if (_webSession === session) _webSession = null;
        _generation++;
        if (session.primed) {
          _primedOutcome = { generation: _generation, error: err, text: null, endedWithCapture: false };
          retireOwner(session.owner);
          stopWebLevelMeter();
          return;
        }
        reportOwnerError(session.owner, err);
        retireOwner(session.owner);
        stopWebLevelMeter();
        return;
      }
      if (session.lastText && !session.emittedFinal) {
        session.emittedFinal = true;
        emitOwnerResult(session.owner, session.lastText, true);
      }
      session.ended = true;
      session.retired = true;
      clearWebRecHandlers(rec);
      if (_webSession === session) _webSession = null;
      _generation++;
      if (session.primed) {
        _primedOutcome = {
          generation: _generation,
          error: null,
          text: session.lastText || null,
          endedWithCapture: true,
        };
        setOwnerListening(session.owner, false);
        retireOwner(session.owner);
        stopWebLevelMeter();
        return;
      }
      // Browser auto-ends on silence; reflect not-listening and retire so stopListening resolves immediately.
      setOwnerListening(session.owner, false);
      retireOwner(session.owner);
      stopWebLevelMeter();
    };
    _webSession = session;
    if (!deferAudioPause) {
      pauseBackgroundAudio();
    }
    rec.start();
    // Do NOT mark _listening / invoke onListeningChange(true) here: in Web Speech API,
    // rec.start() only submits the request; browser permission rejection (not-allowed)
    // arrives asynchronously before onstart/onaudiostart ever fires.
    return true;
  } catch (err) {
    console.warn('[voice] web start failed:', err);
    const msg = err instanceof Error ? err.message : String(err ?? 'Failed to start web speech');
    const mapped = /permission|denied|not-allowed/i.test(msg) ? 'permission_denied' : msg;
    if (primed) {
      if (_webSession && _webSession.generation === generation) {
        _webSession.retired = true;
        clearWebRecHandlers(_webSession.rec);
        _webSession = null;
      }
      _primedOutcome = { generation: ++_generation, error: mapped, text: null, endedWithCapture: false };
      setOwnerListening(owner, false);
      retireOwner(owner);
      return false;
    }
    reportOwnerError(owner, mapped);
    setOwnerListening(owner, false);
    retireOwner(owner);
    return false;
  }
}

/**
 * Synchronously start/unlock Web SpeechRecognition inside a direct browser user
 * gesture (`pointerdown` / `click`), so mobile WebKit/Safari preserves gesture
 * activation across async modal opens or hold timers. Caller adopts via
 * `startListening()` or aborts cleanly via `cancelWebGesturePrime()`.
 */
export function primeWebGesture(options?: { deferAudioPause?: boolean }): boolean {
  if (isNative() || !isAvailable() || !getWebSpeechCtor()) return false;
  if (_pendingStop) return false;
  if (_webSession && !_webSession.retired && !_webSession.ended) {
    return _webSession.primed;
  }
  if (_listening) return false;
  const noop = () => {};
  const primedOwner = createCaptureOwner(noop, noop, noop);
  claimActiveOwner(primedOwner);
  return startWebListening(primedOwner, {
    primed: true,
    deferAudioPause: options?.deferAudioPause === true,
  });
}

/** Silently abort an un-adopted Web Speech gesture prime (e.g. short tap / scroll). */
export function cancelWebGesturePrime(): void {
  _primedOutcome = null;
  const session = _webSession;
  if (!session || !session.primed) return;
  session.retired = true;
  session.ended = true;
  const rec = session.rec;
  if (_webSession === session) _webSession = null;
  _generation++;
  clearWebRecHandlers(rec);
  stopWebLevelMeter();
  retireOwner(session.owner);
  try {
    rec?.abort?.();
  } catch {
    try { rec?.stop?.(); } catch { /* already ended */ }
  }
}

/** Silent cleanup delay in case a browser speech engine omits `onend` after `stop()`.
 * Never emits a timeout error and never cuts off active recording. */
export const WEB_FINAL_DRAIN_MS = 10_000;
/** Upper bound when aborting/cancelling a native recognizer so hung native start/stop calls cannot wedge future holds. */
export const NATIVE_ABORT_DRAIN_MS = 1_500;

export interface StopListeningOptions {
  abort?: boolean;
}

function stopWebListening(abort = false): Promise<void> {
  const session = _webSession;
  const owner = session?.owner ?? _activeOwner;
  if (_listening) {
    setOwnerListening(owner, false);
  }
  stopWebLevelMeter();
  if (abort) {
    _webDrainCancel?.();
    _webDrainCancel = null;
  }
  const rec = session?.rec ?? null;
  if (!session || !rec) {
    _generation++;
    retireOwner(owner);
    return Promise.resolve();
  }
  if (abort) {
    session.retired = true;
    clearWebRecHandlers(rec);
    if (_webSession === session) _webSession = null;
    _generation++;
    retireOwner(owner);
    try { rec.abort?.(); } catch {
      try { rec.stop?.(); } catch { /* already ended */ }
    }
    return Promise.resolve();
  }
  // Do not restart listening or start the level meter if capture starts while draining,
  // but still mark captureStarted so onend does not falsely report permission_denied.
  const markDrainCaptureStarted = (): void => {
    session.captureStarted = true;
  };
  rec.onstart = markDrainCaptureStarted;
  rec.onaudiostart = markDrainCaptureStarted;
  return new Promise((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (_webDrainCancel === finish) _webDrainCancel = null;
      if (!abort && session.captureStarted && session.lastText && !session.emittedFinal && isOwnerCurrent(session.owner)) {
        session.emittedFinal = true;
        emitOwnerResult(session.owner, session.lastText, true);
      }
      session.ended = true;
      session.retired = true;
      stopWebLevelMeter();
      clearWebRecHandlers(rec);
      if (_webSession === session) _webSession = null;
      _generation++;
      if (isOwnerCurrent(session.owner)) {
        retireOwner(session.owner);
      }
      resolve();
    };
    _webDrainCancel = finish;
    const timer = setTimeout(() => {
      // Browser failed to fire onend after stop(); clean up silently without surfacing a timeout error.
      console.warn('[voice] web final drain missing onend; cleaning up silently');
      finish();
      try { rec.abort?.(); } catch { /* already ended */ }
    }, WEB_FINAL_DRAIN_MS);
    // Keep onresult and its generation alive until onend: stop() asks the
    // browser for the remaining final hypothesis, abort() would discard it.
    rec.onend = finish;
    try { rec.stop(); } catch {
      finish();
      try { rec.abort?.(); } catch { /* already ended */ }
    }
  });
}

export async function startListening(
  onResult: (text: string, isFinal: boolean) => void,
  onListeningChange?: (listening: boolean) => void,
  onError?: (error: string) => void,
): Promise<boolean> {
  if (!isAvailable()) {
    const msg = 'Speech recognition is not available';
    _lastError = msg;
    (onError ?? _onError)?.(msg);
    return false;
  }

  const startIntent = ++_intentSeq;

  if (!isNative()) {
    if (_pendingStop) {
      await _pendingStop;
      if (startIntent < _lastStopIntent) return false;
    }
    if (_primedOutcome) {
      const outcome = _primedOutcome;
      _primedOutcome = null;
      if (outcome.error !== null) {
        _prewarmCache = null;
        _lastError = outcome.error;
        (onError ?? _onError)?.(outcome.error);
        return false;
      }
      if (outcome.endedWithCapture) {
        const owner = createCaptureOwner(onResult, onListeningChange, onError);
        claimActiveOwner(owner);
        setOwnerListening(owner, true);
        if (outcome.text) {
          emitOwnerResult(owner, outcome.text, true);
        }
        setOwnerListening(owner, false);
        retireOwner(owner);
        return true;
      }
    }
    const owner = createCaptureOwner(onResult, onListeningChange, onError);
    claimActiveOwner(owner);
    if (_webSession && !_webSession.retired && !_webSession.ended && _webSession.generation === _generation) {
      const session = _webSession;
      const wasPrimed = session.primed;
      session.primed = false;
      session.owner = owner;
      if (wasPrimed && session.deferAudioPause) {
        session.deferAudioPause = false;
        pauseBackgroundAudio();
      }
      if (_listening || session.captureStarted) {
        setOwnerListening(owner, true);
        if (wasPrimed) {
          void startWebLevelMeter(session.generation);
        }
      }
      if (session.lastText) {
        emitOwnerResult(owner, session.lastText, session.emittedFinal);
      }
      return true;
    }
    if (_listening) {
      setOwnerListening(owner, true);
      return true;
    }
    _primedOutcome = null;
    return startWebListening(owner);
  }

  if (_pendingStop) {
    await _pendingStop;
    if (startIntent < _lastStopIntent) return false;
  }

  const owner = createCaptureOwner(onResult, onListeningChange, onError);
  claimActiveOwner(owner);

  if (_listening) {
    if (_nativeSession && !_nativeSession.retired && !_nativeSession.aborted) {
      _nativeSession.owner = owner;
    }
    setOwnerListening(owner, true);
    return true;
  }

  if (_pendingStart && _pendingStart.generation === _generation) {
    _pendingStart.session.owner = owner;
    return _pendingStart.promise;
  }

  const generation = ++_generation;
  const session: NativeSession = {
    generation,
    owner,
    recognition: getNativeSpeechRecognition(),
    text: null,
    final: false,
    aborted: false,
    retired: false,
    stopStarted: false,
    handles: [],
  };
  const startPromise = startListeningInternal(session);
  const entry = { promise: startPromise, generation, session };
  _pendingStart = entry;
  try {
    return await startPromise;
  } finally {
    if (_pendingStart === entry) {
      _pendingStart = null;
    }
  }
}

export async function stopListening(options?: StopListeningOptions): Promise<void> {
  const abort = options?.abort === true;
  _lastStopIntent = ++_intentSeq;
  if (!isAvailable()) return;

  if (!isNative()) {
    if (abort) {
      const aborting = stopWebListening(true);
      _pendingStop = aborting;
      try { await aborting; }
      finally { if (_pendingStop === aborting) _pendingStop = null; }
      return;
    }
    if (_pendingStop) return _pendingStop;
    const stopping = stopWebListening(false);
    _pendingStop = stopping;
    try { await stopping; }
    finally { if (_pendingStop === stopping) _pendingStop = null; }
    return;
  }

  if (abort) {
    const priorPendingStop = _pendingStop;
    const pendingEntry = _pendingStart;
    const startPromise = pendingEntry?.promise ?? null;
    _pendingStart = null;
    const session = _nativeSession ?? pendingEntry?.session ?? null;
    const owner = session?.owner ?? _activeOwner;
    const shouldStopNative = !!(session && !session.stopStarted && (_listening || !!startPromise));
    if (session) {
      session.aborted = true;
      session.retired = true;
      if (shouldStopNative) {
        session.stopStarted = true;
      }
      if (_nativeSession === session) {
        _nativeSession = null;
      }
    }
    _generation++;
    setOwnerListening(owner, false);
    retireOwner(owner);

    // Detach listener handles immediately in parallel so a hung prior stop/start/stop
    // cannot leave old native listeners attached across an abort timeout.
    const detachPromise = cleanupSessionListeners(session).catch(() => {});
    const stopCallPromise = shouldStopNative && session
      ? session.recognition.stop().catch((err) => {
          console.warn('[voice] abort stop failed:', err);
        })
      : Promise.resolve();
    const priorStopWait = priorPendingStop ? priorPendingStop.catch(() => {}) : Promise.resolve();
    const startWait = startPromise ? startPromise.catch(() => false) : Promise.resolve();
    const cleanupAndStop = Promise.all([
      detachPromise,
      stopCallPromise,
      priorStopWait,
      startWait,
    ]).then(() => {});

    let abortTimer: ReturnType<typeof setTimeout> | null = null;
    const boundedAbort = (async () => {
      try {
        await Promise.race([
          cleanupAndStop,
          new Promise<void>((resolve) => {
            abortTimer = setTimeout(() => {
              abortTimer = null;
              console.warn('[voice] native abort drain timed out; releasing session');
              resolve();
            }, NATIVE_ABORT_DRAIN_MS);
          }),
        ]);
      } finally {
        if (abortTimer !== null) {
          clearTimeout(abortTimer);
          abortTimer = null;
        }
        if (session && _nativeSession === session) _nativeSession = null;
      }
    })();

    _pendingStop = boundedAbort;
    try {
      await boundedAbort;
    } finally {
      if (_pendingStop === boundedAbort) {
        _pendingStop = null;
      }
    }
    return;
  }

  if (_pendingStop) {
    _generation++;
    _pendingStart = null;
    return _pendingStop;
  }
  const pendingEntry = _pendingStart;
  const startPromise = pendingEntry?.promise ?? null;
  _pendingStart = null;
  const session = _nativeSession ?? pendingEntry?.session ?? null;
  const owner = session?.owner ?? _activeOwner;
  const shouldStopNative = _listening || !!startPromise;
  _generation++;
  setOwnerListening(owner, false);

  if (!shouldStopNative) {
    if (session) session.retired = true;
    await cleanupSessionListeners(session);
    if (_nativeSession === session) _nativeSession = null;
    retireOwner(owner);
    return;
  }

  if (session) {
    session.stopStarted = true;
  }

  let stopPromise!: Promise<void>;
  stopPromise = (async () => {
    let stopFailure: string | null = null;
    try {
      await session?.recognition.stop();
    } catch (err) {
      console.warn('[voice] stop failed:', err);
      const msg = err instanceof Error && err.message.trim() ? err.message.trim() : String(err ?? '');
      stopFailure = msg || 'Speech recognition stop failed';
    }

    try {
      await startPromise;
    } catch { /* start failure already handled */ }

    const stillCurrentOwner = !!owner
      && isOwnerCurrent(owner)
      && (!session || (!session.retired && !session.aborted && _nativeSession === session));
    if (stopFailure && stillCurrentOwner) {
      reportOwnerError(owner, stopFailure);
    }

    await cleanupSessionListeners(session);
    if (session) session.retired = true;
    if (_nativeSession === session) _nativeSession = null;
    if (stillCurrentOwner) {
      retireOwner(owner);
    }
  })();

  _pendingStop = stopPromise;
  try {
    await stopPromise;
  } finally {
    if (_pendingStop === stopPromise) {
      _pendingStop = null;
    }
  }
}

/** Register a callback for real-time audio level (0..1). Call before startListening. */
export function onAudioLevel(cb: ((level: number) => void) | null): void {
  _onLevel = cb;
}

/** Register a callback for recognition / permission / startup errors. */
export function onRecognitionError(cb: ((error: string) => void) | null): void {
  _onError = cb;
}

export function getLastError(): string | null {
  return _lastError;
}

export function isListening(): boolean {
  return _listening;
}
