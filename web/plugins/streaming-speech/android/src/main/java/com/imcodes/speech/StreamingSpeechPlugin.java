package com.imcodes.speech;

import android.Manifest;
import androidx.lifecycle.Lifecycle;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.view.HapticFeedbackConstants;
import android.view.View;
import ai.onnxruntime.OrtException;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.DoubleConsumer;

/** Audio never leaves this device. One serial worker owns all native ONNX decoder state. */
@CapacitorPlugin(name = "StreamingSpeech", permissions = {
    @Permission(alias = "speechRecognition", strings = { Manifest.permission.RECORD_AUDIO })
})
public class StreamingSpeechPlugin extends Plugin {
    private static final int SAMPLE_RATE = Qwen3SpeechWindow.SAMPLE_RATE;
    private static final int READ_CHUNK_SAMPLES = 800; // 50ms chunks matching iOS 20fps audioLevel cadence
    private static final int TTS_FALLBACK_MAX_INPUT_LENGTH = 3900;
    private static final long TTS_INIT_TIMEOUT_MS = 5000L;

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicLong generation = new AtomicLong();
    private final Object captureLock = new Object();
    private Qwen3OnnxDecoder decoder;
    private volatile Boolean cachedAssetsAvailable;
    private CaptureSession activeSession;
    private volatile AudioRecord recorder;
    private volatile boolean listening;

    private final Object ttsLock = new Object();
    private final AtomicLong ttsGeneration = new AtomicLong();
    private final List<PendingSpeakRequest> pendingTtsRequests = new ArrayList<>();
    private final Handler ttsMainHandler = new Handler(Looper.getMainLooper());
    private TextToSpeech tts;
    private long ttsInitGeneration = 0L;
    private boolean ttsReady = false;
    private boolean ttsInitializing = false;
    private volatile boolean ttsSpeaking = false;
    private long activeTtsSessionId = 0L;
    private int activeTtsChunkCount = 0;
    private AudioManager ttsAudioManager;
    private AudioFocusRequest ttsAudioFocusRequest;
    private boolean ttsHasAudioFocus = false;
    private final AudioManager.OnAudioFocusChangeListener ttsFocusChangeListener = focusChange -> {
        if (focusChange == AudioManager.AUDIOFOCUS_LOSS
            || focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
            stopTtsInternal(true);
        }
    };

    @Override
    public void load() {
        worker.execute(() -> {
            try {
                ensureDecoder();
            } catch (Exception | LinkageError ignored) {
                // Deferred to start() where initialization errors surface to the caller.
            }
        });
    }

    private Qwen3OnnxDecoder ensureDecoder() throws IOException, OrtException {
        if (decoder != null) return decoder;
        // ORT cannot resolve external .weights from an in-memory Android asset.
        // Coordinate through the shared single-flight extractor so startup warmup and plugin calls never race.
        File root = SpeechModelExtractor.ensureExtracted(getContext());
        String hotwords = SpeechModelExtractor.readHotwords(getContext());
        decoder = new Qwen3OnnxDecoder(
            root,
            hotwords,
            0,
            Qwen3OnnxDecoder.DEFAULT_MAX_TOTAL_LEN,
            Qwen3OnnxDecoder.DEFAULT_MAX_NEW_TOKENS
        );
        return decoder;
    }

    private Qwen3SpeechWindow.DecodeResult decodeSamples(
        Qwen3OnnxDecoder activeDecoder,
        float[] samples,
        int count,
        int[] prefixTokens,
        CaptureSession session,
        long owner
    ) throws OrtException {
        if (count == 0) return new Qwen3SpeechWindow.DecodeResult("", new int[0]);
        return activeDecoder.transcribe(
            samples,
            count,
            prefixTokens,
            session.language,
            () -> !session.isDiscarded() && generation.get() == owner
        );
    }

    @PluginMethod
    public void prewarm(PluginCall call) {
        SpeechModelExtractor.warmUpAsync(getContext());
        worker.execute(() -> {
            try {
                ensureDecoder();
            } catch (Exception | LinkageError ignored) {
                // Deferred to start() where initialization errors surface to the caller.
            }
        });
        call.resolve();
    }

    @PluginMethod
    public void available(PluginCall call) {
        Boolean cached = cachedAssetsAvailable;
        if (cached == null) {
            boolean ready = SpeechModelExtractor.areAssetsAvailable(getContext());
            cached = ready;
            if (ready) {
                cachedAssetsAvailable = cached;
            }
        }
        JSObject result = new JSObject();
        result.put("available", cached);
        call.resolve(result);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("speechRecognition") != PermissionState.GRANTED) {
            requestPermissionForAlias("speechRecognition", call, "microphonePermission");
            return;
        }
        begin(call);
    }

    @PermissionCallback
    private void microphonePermission(PluginCall call) {
        if (getPermissionState("speechRecognition") != PermissionState.GRANTED) {
            call.reject("Microphone permission denied");
            return;
        }
        begin(call);
    }

    private void begin(PluginCall call) {
        if (worker.isShutdown() || !getActivity().getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED)) {
            call.reject("Speech requires a foreground app");
            return;
        }
        stopTtsInternal(true);
        synchronized (captureLock) {
            if (listening) {
                call.resolve();
                return;
            }
            int min = AudioRecord.getMinBufferSize(
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            );
            if (min <= 0) {
                call.reject("Offline speech could not start", new IOException("Microphone format unavailable"));
                return;
            }
            // Buffer at least 6 seconds of 16kHz 16-bit mono PCM (~192KB) so speech captured
            // while the worker thread finishes warming up the model is never lost.
            int bufferSizeInBytes = Math.max(min * 2, SAMPLE_RATE * 2 * 6);
            AudioRecord audio = createAudioRecord(bufferSizeInBytes);
            if (audio == null) {
                call.reject("Offline speech could not start", new IOException("Microphone initialization failed"));
                return;
            }
            try {
                audio.startRecording();
            } catch (IllegalStateException e) {
                audio.release();
                call.reject("Offline speech could not start", e);
                return;
            }
            if (audio.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                try { audio.stop(); } catch (IllegalStateException ignored) { }
                audio.release();
                call.reject("Offline speech could not start", new IOException("Microphone start failed"));
                return;
            }
            long owner = generation.incrementAndGet();
            String language = Qwen3OnnxDecoder.resolveLanguage(call.getString("language"));
            CaptureSession session = new CaptureSession(owner, audio, language);
            activeSession = session;
            recorder = audio;
            listening = true;
            state("started");
            Thread reader = new Thread(() -> runReader(session), "imcodes-speech-audio-" + owner);
            reader.setDaemon(true);
            reader.start();
            session.awaitReaderStart();
            call.resolve();
            worker.execute(() -> capture(call, owner, audio, session));
        }
    }

    // Isolated audio capture factory/reader helpers keep AudioRecord configuration
    // cleanly separated from segmentation, SpeechGain conditioning, and ORT decoding.
    private static AudioRecord createAudioRecord(int bufferSizeInBytes) {
        // Prefer VOICE_RECOGNITION to avoid OS/OEM hardware AGC & noise-suppression pumping.
        int[] sources = {
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            MediaRecorder.AudioSource.MIC,
        };
        for (int source : sources) {
            AudioRecord candidate = null;
            try {
                candidate = new AudioRecord(
                    source,
                    SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    bufferSizeInBytes
                );
                if (candidate.getState() == AudioRecord.STATE_INITIALIZED) {
                    return candidate;
                }
            } catch (IllegalArgumentException | SecurityException ignored) {
                // Fall back to next audio source when this source is rejected by the HAL.
            }
            if (candidate != null) {
                try { candidate.release(); } catch (RuntimeException ignored) { }
            }
        }
        return null;
    }

    private static float[] pcm16ToNormalizedFloats(short[] pcm, int count) {
        float[] samples = new float[count];
        for (int i = 0; i < count; i++) {
            samples[i] = pcm[i] / 32768.0f;
        }
        return samples;
    }

    private void runReader(CaptureSession session) {
        short[] pcm = new short[READ_CHUNK_SAMPLES];
        session.markReaderStarted();
        try {
            while (!session.isDiscarded()) {
                int count = session.audio.read(pcm, 0, pcm.length, AudioRecord.READ_BLOCKING);
                if (count <= 0) {
                    session.markFirstPassDone();
                    if (session.isStopRequested() || session.isDiscarded()) break;
                    session.failRead(new IOException("Microphone read failed: " + count));
                    break;
                }
                float[] samples = pcm16ToNormalizedFloats(pcm, count);
                if (!session.offerSamples(samples, count, (levelValue) -> {
                    JSObject level = new JSObject();
                    level.put("level", levelValue);
                    notifyListeners("audioLevel", level);
                })) {
                    session.markFirstPassDone();
                    session.stopIntake();
                    break;
                }
                session.markFirstPassDone();
            }
        } catch (Exception e) {
            session.markFirstPassDone();
            if (!session.isStopRequested() && !session.isDiscarded()) {
                session.failRead(e);
            }
        } finally {
            session.markFirstPassDone();
            synchronized (captureLock) {
                session.releaseAudioResources();
                if (recorder == session.audio) recorder = null;
            }
            session.finishReader();
        }
    }

    private void capture(PluginCall call, long owner, AudioRecord audio, CaptureSession session) {
        Qwen3OnnxDecoder activeDecoder = null;
        Qwen3SpeechWindow window = new Qwen3SpeechWindow();
        boolean failed = false;
        try {
            if (session.isDiscarded() || generation.get() != owner) return;
            activeDecoder = ensureDecoder();
            if (session.isDiscarded() || generation.get() != owner) return;
            activeDecoder.resetStreamingCache();
            final Qwen3OnnxDecoder dec = activeDecoder;
            final boolean expectLanguageHeader = Qwen3OnnxDecoder.resolveLanguage(session.language) == null;
            final Qwen3SpeechWindow.RollbackFn rollbackFn = (tokens, rollbackCount) ->
                dec.safePrefixTokensForRollback(tokens, rollbackCount, expectLanguageHeader);
            final Qwen3SpeechWindow.DecodeFn decodeFn = (pcm, count, prefixTokens) -> {
                try {
                    return decodeSamples(dec, pcm, count, prefixTokens, session, owner);
                } catch (OrtException e) {
                    throw new Qwen3SpeechWindow.DecodeException(e.getMessage());
                }
            };
            while (!session.isDiscarded() && generation.get() == owner) {
                AudioBatch batch = session.pollSamples(generation);
                if (batch == null) break;
                window.append(
                    batch.samples,
                    batch.speech,
                    batch.trailingSilence,
                    batch.activeSamples,
                    batch.noiseFloorRMS,
                    batch.finalTail,
                    () -> !session.isStopRequested() && !session.isDiscarded() && generation.get() == owner,
                    () -> !session.isDiscarded() && generation.get() == owner,
                    rollbackFn,
                    decodeFn,
                    (text) -> {
                        if (!session.isDiscarded() && generation.get() == owner) {
                            partial(text, false);
                        }
                    }
                );
                if (batch.finalTail) break;
            }
        } catch (Qwen3SpeechWindow.CancelledException ignored) {
            // Cancelled due to discard or session replacement; suppress errors.
        } catch (Exception | LinkageError e) {
            failed = true;
            session.stopIntake();
            if (!session.isDiscarded() && generation.get() == owner) {
                String message = "Offline speech processing overloaded".equals(e.getMessage())
                    ? "Offline speech processing overloaded"
                    : "Offline speech interrupted";
                JSObject error = new JSObject();
                error.put("message", message);
                notifyListeners("recognitionError", error);
            }
        } finally {
            session.stopIntake();
            // Normal stop drains every accepted PCM chunk before the final barrier.
            if (!failed && !session.isDiscarded() && generation.get() == owner && activeDecoder != null) {
                try {
                    final Qwen3OnnxDecoder dec = activeDecoder;
                    final boolean expectLanguageHeader = Qwen3OnnxDecoder.resolveLanguage(session.language) == null;
                    String full = window.finish(
                        () -> !session.isDiscarded() && generation.get() == owner,
                        (tokens, rollbackCount) -> dec.safePrefixTokensForRollback(tokens, rollbackCount, expectLanguageHeader),
                        (pcm, count, prefixTokens) -> {
                            try {
                                return decodeSamples(dec, pcm, count, prefixTokens, session, owner);
                            } catch (OrtException e) {
                                throw new Qwen3SpeechWindow.DecodeException(e.getMessage());
                            }
                        }
                    );
                    if (!session.isDiscarded() && generation.get() == owner) partial(full, true);
                } catch (Qwen3SpeechWindow.CancelledException ignored) {
                    // Suppressed on discard/replacement.
                } catch (Exception | LinkageError error) {
                    JSObject failure = new JSObject();
                    failure.put("message", "Offline speech final decoding failed");
                    notifyListeners("recognitionError", failure);
                }
            }
            if (activeDecoder != null && generation.get() == owner) {
                activeDecoder.resetStreamingCache();
            }
            synchronized (captureLock) {
                session.releaseAudioResources();
                if (recorder == audio) recorder = null;
                if (activeSession == session) {
                    activeSession = null;
                    listening = false;
                }
            }
            if (!session.isDiscarded() && generation.get() == owner) state("stopped");
        }
    }

    private static final class AudioBatch {
        final float[] samples;
        final boolean speech;
        final int trailingSilence;
        final int activeSamples;
        final float noiseFloorRMS;
        final boolean finalTail;

        AudioBatch(
            float[] samples,
            boolean speech,
            int trailingSilence,
            int activeSamples,
            float noiseFloorRMS,
            boolean finalTail
        ) {
            this.samples = samples;
            this.speech = speech;
            this.trailingSilence = trailingSilence;
            this.activeSamples = activeSamples;
            this.noiseFloorRMS = noiseFloorRMS;
            this.finalTail = finalTail;
        }
    }

    private static final class CaptureSession {
        final long owner;
        final AudioRecord audio;
        final String language;
        private final Qwen3SpeechWindow.SpeechInbox inbox = new Qwen3SpeechWindow.SpeechInbox(new SpeechGain());
        private final CountDownLatch readerStarted = new CountDownLatch(1);
        private final CountDownLatch firstPassDone = new CountDownLatch(1);
        private boolean audioReleased;
        private boolean stopRequested;
        private boolean discarded;
        private boolean readerDone;
        private boolean overflowed;
        private Exception readError;

        CaptureSession(long owner, AudioRecord audio, String language) {
            this.owner = owner;
            this.audio = audio;
            this.language = language;
        }

        synchronized void releaseAudioResources() {
            if (audioReleased) return;
            audioReleased = true;
            try { audio.stop(); } catch (IllegalStateException ignored) { }
            audio.release();
        }

        void markReaderStarted() {
            readerStarted.countDown();
        }

        void markFirstPassDone() {
            firstPassDone.countDown();
        }

        void awaitReaderStart() {
            try {
                readerStarted.await(200, TimeUnit.MILLISECONDS);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }

        synchronized boolean isStopRequested() {
            return stopRequested;
        }

        synchronized boolean isDiscarded() {
            return discarded;
        }

        synchronized boolean offerSamples(float[] samples, int count, DoubleConsumer onAudioLevel) {
            if (discarded) return false;
            boolean admitted;
            try {
                admitted = inbox.offer(samples, count);
            } catch (IOException overload) {
                overflowed = true;
                stopRequested = true;
                notifyAll();
                return false;
            }
            if (admitted) {
                Double levelValue = inbox.pollAudioLevel(System.nanoTime());
                if (levelValue != null) {
                    onAudioLevel.accept(levelValue);
                }
                notifyAll();
            }
            return true;
        }

        synchronized void failRead(Exception error) {
            if (readError == null) readError = error;
            stopRequested = true;
            notifyAll();
        }

        synchronized void finishReader() {
            readerDone = true;
            notifyAll();
        }

        synchronized AudioBatch pollSamples(AtomicLong generation) throws Exception {
            while ((inbox.isEmpty() || stopRequested) && !readerDone && !discarded && generation.get() == owner) {
                wait();
            }
            if (discarded || generation.get() != owner) return null;
            if (overflowed) {
                throw new IOException("Offline speech processing overloaded");
            }
            Qwen3SpeechWindow.SpeechInbox.Batch batch = inbox.take();
            if (batch != null) {
                // Bind stop ownership at the drain boundary so stop cannot turn two
                // full inboxes into an unbounded utterance tail.
                return new AudioBatch(
                    batch.samples,
                    batch.speech,
                    batch.trailingSilence,
                    batch.activeSamples,
                    batch.noiseFloorRMS,
                    stopRequested && readerDone
                );
            }
            if (readError != null) {
                throw readError;
            }
            return null;
        }

        void stopIntake() {
            try {
                firstPassDone.await(50, TimeUnit.MILLISECONDS);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
            synchronized (this) {
                if (!stopRequested) {
                    stopRequested = true;
                    notifyAll();
                }
            }
            try {
                audio.stop();
            } catch (IllegalStateException ignored) {
            }
        }

        void discard() {
            firstPassDone.countDown();
            synchronized (this) {
                discarded = true;
                stopRequested = true;
                inbox.clear();
                notifyAll();
            }
            try {
                audio.stop();
            } catch (IllegalStateException ignored) {
            }
        }
    }

    private void partial(String text, boolean isFinal) {
        JSObject result = new JSObject();
        result.put("matches", new JSArray().put(text));
        result.put("isFinal", isFinal);
        notifyListeners("partialResults", result);
    }

    private void state(String status) {
        JSObject result = new JSObject();
        result.put("status", status);
        notifyListeners("listeningState", result);
    }

    private void stopCapture(boolean discard) {
        CaptureSession session;
        synchronized (captureLock) {
            if (discard) generation.incrementAndGet();
            session = activeSession;
            activeSession = null;
            listening = false;
            if (discard && recorder != null) {
                try { recorder.stop(); } catch (IllegalStateException ignored) { }
            }
        }
        if (session != null) {
            if (discard) session.discard();
            else session.stopIntake();
        }
    }

    @PluginMethod
    public void performHaptic(PluginCall call) {
        if (getBridge() == null || getBridge().getWebView() == null) {
            call.resolve();
            return;
        }
        View webView = getBridge().getWebView();
        webView.post(() -> {
            try {
                webView.performHapticFeedback(
                    HapticFeedbackConstants.LONG_PRESS,
                    HapticFeedbackConstants.FLAG_IGNORE_VIEW_SETTING
                );
            } catch (RuntimeException ignored) {
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String rawText = call.getString("text");
        String trimmed = rawText == null ? "" : rawText.trim();
        if (trimmed.isEmpty()) {
            call.reject("TTS text is required");
            return;
        }
        String lang = call.getString("lang");
        Double rawRate = call.getDouble("rate");
        float rate = clampTtsRate(rawRate == null ? 1.0 : rawRate);
        long sessionId = ttsGeneration.incrementAndGet();

        stopCapture(false);

        PendingSpeakRequest request = new PendingSpeakRequest(call, sessionId, trimmed, lang, rate);
        synchronized (ttsLock) {
            if (ttsReady && tts != null) {
                executeSpeakLocked(request);
                return;
            }
            pendingTtsRequests.add(request);
            if (!ttsInitializing) {
                startTtsInitLocked();
            }
        }
    }

    @PluginMethod
    public void stopSpeaking(PluginCall call) {
        stopTtsInternal(true);
        call.resolve();
    }

    @PluginMethod
    public void isSpeaking(PluginCall call) {
        boolean speaking;
        synchronized (ttsLock) {
            speaking = ttsSpeaking || (tts != null && tts.isSpeaking());
        }
        JSObject result = new JSObject();
        result.put("speaking", speaking);
        call.resolve(result);
    }

    static float clampTtsRate(double rate) {
        if (Double.isNaN(rate) || Double.isInfinite(rate)) {
            return 1.0f;
        }
        double clamped = Math.max(0.5, Math.min(2.0, rate));
        return (float) clamped;
    }

    static List<String> splitTextForTts(String text, int maxLength) {
        List<String> chunks = new ArrayList<>();
        if (text == null) return chunks;
        String trimmed = text.trim();
        if (trimmed.isEmpty()) return chunks;
        int limit = Math.max(1, maxLength);
        int cursor = 0;
        int len = trimmed.length();
        while (cursor < len) {
            int remaining = len - cursor;
            if (remaining <= limit) {
                String tail = trimmed.substring(cursor).trim();
                if (!tail.isEmpty()) chunks.add(tail);
                break;
            }
            int end = cursor + limit;
            int splitAt = -1;
            for (int i = end; i > cursor + (limit / 3); i--) {
                char ch = trimmed.charAt(i - 1);
                if (ch == '\n' || ch == '。' || ch == '！' || ch == '？'
                    || ch == '.' || ch == '!' || ch == '?' || ch == '；' || ch == ';') {
                    splitAt = i;
                    break;
                }
            }
            if (splitAt == -1) {
                for (int i = end; i > cursor + (limit / 3); i--) {
                    char ch = trimmed.charAt(i - 1);
                    if (ch == '，' || ch == ',' || Character.isWhitespace(ch)) {
                        splitAt = i;
                        break;
                    }
                }
            }
            if (splitAt == -1 || splitAt <= cursor) {
                splitAt = end;
            }
            String piece = trimmed.substring(cursor, splitAt).trim();
            if (!piece.isEmpty()) chunks.add(piece);
            cursor = splitAt;
            while (cursor < len && Character.isWhitespace(trimmed.charAt(cursor))) {
                cursor++;
            }
        }
        return chunks;
    }

    private void startTtsInitLocked() {
        android.content.Context context = getContext();
        if (context == null) {
            failPendingTtsInitLocked("System TTS context unavailable");
            return;
        }
        ttsInitializing = true;
        final long initSeq = ++ttsInitGeneration;
        final android.content.Context appContext = context.getApplicationContext();
        final Runnable timeoutTask = () -> {
            synchronized (ttsLock) {
                if (initSeq != ttsInitGeneration || !ttsInitializing || ttsReady) return;
                ttsInitializing = false;
                if (tts != null) {
                    try { tts.shutdown(); } catch (RuntimeException ignored) { }
                    tts = null;
                }
                failPendingTtsInitLocked("System TTS engine unavailable on this device");
            }
        };
        ttsMainHandler.postDelayed(timeoutTask, TTS_INIT_TIMEOUT_MS);
        try {
            final int[] syncStatus = new int[] { Integer.MIN_VALUE };
            final boolean[] ctorFinished = new boolean[] { false };
            TextToSpeech created = new TextToSpeech(appContext, status -> {
                ttsMainHandler.removeCallbacks(timeoutTask);
                synchronized (ttsLock) {
                    if (!ctorFinished[0]) {
                        syncStatus[0] = status;
                        return;
                    }
                    onTtsInitCompletedLocked(initSeq, status);
                }
            });
            ctorFinished[0] = true;
            tts = created;
            if (syncStatus[0] != Integer.MIN_VALUE) {
                onTtsInitCompletedLocked(initSeq, syncStatus[0]);
            }
        } catch (Exception | LinkageError err) {
            ttsMainHandler.removeCallbacks(timeoutTask);
            ttsInitializing = false;
            ttsReady = false;
            tts = null;
            failPendingTtsInitLocked("System TTS engine unavailable on this device");
        }
    }

    private void onTtsInitCompletedLocked(long initSeq, int status) {
        ttsInitializing = false;
        if (initSeq != ttsInitGeneration || tts == null) {
            return;
        }
        if (status != TextToSpeech.SUCCESS) {
            ttsReady = false;
            try { tts.shutdown(); } catch (RuntimeException ignored) { }
            tts = null;
            failPendingTtsInitLocked("System TTS engine unavailable on this device");
            return;
        }
        ttsReady = true;
        configureTtsListenerLocked(tts);
        flushPendingTtsRequestsLocked();
    }

    private void configureTtsListenerLocked(TextToSpeech engine) {
        engine.setAudioAttributes(new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build());
        engine.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override
            public void onStart(String utteranceId) {
                TtsUtteranceRef ref = parseTtsUtteranceId(utteranceId);
                if (ref == null) return;
                synchronized (ttsLock) {
                    if (ref.sessionId != activeTtsSessionId) return;
                    if (ref.chunkIndex == 0) {
                        ttsSpeaking = true;
                        emitTtsState("started", null);
                    }
                }
            }

            @Override
            public void onDone(String utteranceId) {
                TtsUtteranceRef ref = parseTtsUtteranceId(utteranceId);
                if (ref == null) return;
                synchronized (ttsLock) {
                    if (ref.sessionId != activeTtsSessionId) return;
                    if (ref.chunkIndex >= activeTtsChunkCount - 1) {
                        ttsSpeaking = false;
                        abandonTtsAudioFocusLocked();
                        emitTtsState("stopped", null);
                    }
                }
            }

            @Override
            public void onStop(String utteranceId, boolean interrupted) {
                TtsUtteranceRef ref = parseTtsUtteranceId(utteranceId);
                if (ref == null) return;
                synchronized (ttsLock) {
                    if (ref.sessionId != activeTtsSessionId) return;
                    ttsSpeaking = false;
                    abandonTtsAudioFocusLocked();
                    emitTtsState("stopped", null);
                }
            }

            @Override
            public void onError(String utteranceId) {
                onError(utteranceId, TextToSpeech.ERROR);
            }

            @Override
            public void onError(String utteranceId, int errorCode) {
                TtsUtteranceRef ref = parseTtsUtteranceId(utteranceId);
                if (ref == null) return;
                synchronized (ttsLock) {
                    if (ref.sessionId != activeTtsSessionId) return;
                    ttsSpeaking = false;
                    abandonTtsAudioFocusLocked();
                    emitTtsState("error", "System TTS playback failed (" + errorCode + ")");
                }
            }
        });
    }

    private void failPendingTtsInitLocked(String message) {
        List<PendingSpeakRequest> queued = new ArrayList<>(pendingTtsRequests);
        pendingTtsRequests.clear();
        for (PendingSpeakRequest req : queued) {
            req.call.reject(message);
        }
        emitTtsState("error", message);
    }

    private void flushPendingTtsRequestsLocked() {
        List<PendingSpeakRequest> queued = new ArrayList<>(pendingTtsRequests);
        pendingTtsRequests.clear();
        long latestGen = ttsGeneration.get();
        for (PendingSpeakRequest req : queued) {
            if (req.sessionId != latestGen) {
                req.call.resolve();
                continue;
            }
            executeSpeakLocked(req);
        }
    }

    private void executeSpeakLocked(PendingSpeakRequest req) {
        if (tts == null || !ttsReady) {
            req.call.reject("System TTS engine unavailable on this device");
            return;
        }
        if (req.sessionId != ttsGeneration.get()) {
            req.call.resolve();
            return;
        }
        int engineLimit = TextToSpeech.getMaxSpeechInputLength();
        int maxLen = engineLimit > 200 ? Math.min(TTS_FALLBACK_MAX_INPUT_LENGTH, engineLimit - 100) : TTS_FALLBACK_MAX_INPUT_LENGTH;
        List<String> chunks = splitTextForTts(req.text, maxLen);
        if (chunks.isEmpty()) {
            req.call.reject("TTS text is required");
            return;
        }

        requestTtsAudioFocusLocked();
        applyTtsLanguageLocked(tts, req.lang);
        tts.setSpeechRate(req.rate);

        activeTtsSessionId = req.sessionId;
        activeTtsChunkCount = chunks.size();
        for (int i = 0; i < chunks.size(); i++) {
            String utteranceId = "imcodes_tts_" + req.sessionId + "_" + i + "_" + chunks.size();
            int queueMode = i == 0 ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD;
            int status = tts.speak(chunks.get(i), queueMode, null, utteranceId);
            if (status == TextToSpeech.ERROR) {
                ttsSpeaking = false;
                activeTtsSessionId = 0L;
                activeTtsChunkCount = 0;
                abandonTtsAudioFocusLocked();
                emitTtsState("error", "System TTS failed to queue speech");
                req.call.reject("System TTS failed to queue speech");
                return;
            }
        }
        ttsSpeaking = true;
        req.call.resolve();
    }

    private static int rankTtsVoice(Voice voice, Locale requested, String requestedPrimary) {
        if (voice == null || voice.getLocale() == null) return -1;
        Locale vLocale = voice.getLocale();
        String vLang = vLocale.getLanguage();
        if (vLang == null || !vLang.equalsIgnoreCase(requestedPrimary)) return -1;
        String reqCountry = requested.getCountry();
        String vCountry = vLocale.getCountry();
        boolean exactMatch = reqCountry == null || reqCountry.isEmpty()
            ? vLocale.toLanguageTag().equalsIgnoreCase(requested.toLanguageTag())
            : reqCountry.equalsIgnoreCase(vCountry);
        boolean offline = !voice.isNetworkConnectionRequired();
        int quality = voice.getQuality();
        int qualityTier;
        if (quality >= Voice.QUALITY_VERY_HIGH) {
            qualityTier = 4;
        } else if (quality >= Voice.QUALITY_HIGH) {
            qualityTier = 3;
        } else if (quality >= Voice.QUALITY_NORMAL) {
            qualityTier = 2;
        } else {
            qualityTier = 1;
        }
        return (exactMatch ? 100 : 0) + (offline ? 20 : 0) + qualityTier;
    }

    private static void applyTtsLanguageLocked(TextToSpeech engine, String rawLang) {
        if (rawLang == null || rawLang.trim().isEmpty()) return;
        String normalized = rawLang.trim().replace('_', '-');
        Locale requested = Locale.forLanguageTag(normalized);
        String primaryLang = requested.getLanguage();
        if (primaryLang == null || primaryLang.isEmpty()) return;

        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.LOLLIPOP) {
            try {
                java.util.Set<Voice> voices = engine.getVoices();
                if (voices != null && !voices.isEmpty()) {
                    Voice bestVoice = null;
                    int bestScore = -1;
                    for (Voice candidate : voices) {
                        int score = rankTtsVoice(candidate, requested, primaryLang);
                        if (score > bestScore) {
                            bestScore = score;
                            bestVoice = candidate;
                        }
                    }
                    if (bestVoice != null && engine.setVoice(bestVoice) == TextToSpeech.SUCCESS) {
                        return;
                    }
                }
            } catch (Exception ignored) {
                // Fall back to setLanguage when getVoices/setVoice is unsupported or throws.
            }
        }

        int availability = engine.isLanguageAvailable(requested);
        if (availability >= TextToSpeech.LANG_AVAILABLE) {
            engine.setLanguage(requested);
            return;
        }
        Locale primary = new Locale(primaryLang);
        if (engine.isLanguageAvailable(primary) >= TextToSpeech.LANG_AVAILABLE) {
            engine.setLanguage(primary);
        }
    }

    private void requestTtsAudioFocusLocked() {
        android.content.Context context = getContext();
        if (context == null) return;
        if (ttsAudioManager == null) {
            ttsAudioManager = (AudioManager) context.getApplicationContext().getSystemService(android.content.Context.AUDIO_SERVICE);
        }
        if (ttsAudioManager == null || ttsHasAudioFocus) return;
        AudioAttributes attrs = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ttsAudioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(attrs)
                .setOnAudioFocusChangeListener(ttsFocusChangeListener)
                .build();
            int res = ttsAudioManager.requestAudioFocus(ttsAudioFocusRequest);
            ttsHasAudioFocus = (res == AudioManager.AUDIOFOCUS_REQUEST_GRANTED);
        } else {
            @SuppressWarnings("deprecation")
            int res = ttsAudioManager.requestAudioFocus(
                ttsFocusChangeListener,
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
            );
            ttsHasAudioFocus = (res == AudioManager.AUDIOFOCUS_REQUEST_GRANTED);
        }
    }

    private void abandonTtsAudioFocusLocked() {
        if (!ttsHasAudioFocus || ttsAudioManager == null) {
            ttsHasAudioFocus = false;
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (ttsAudioFocusRequest != null) {
                ttsAudioManager.abandonAudioFocusRequest(ttsAudioFocusRequest);
                ttsAudioFocusRequest = null;
            }
        } else {
            @SuppressWarnings("deprecation")
            int ignored = ttsAudioManager.abandonAudioFocus(ttsFocusChangeListener);
        }
        ttsHasAudioFocus = false;
    }

    private void stopTtsInternal(boolean emitStoppedEvent) {
        ttsGeneration.incrementAndGet();
        synchronized (ttsLock) {
            boolean wasActive = ttsSpeaking || (tts != null && tts.isSpeaking());
            activeTtsSessionId = 0L;
            activeTtsChunkCount = 0;
            ttsSpeaking = false;
            for (PendingSpeakRequest req : pendingTtsRequests) {
                req.call.resolve();
            }
            pendingTtsRequests.clear();
            if (tts != null) {
                try { tts.stop(); } catch (RuntimeException ignored) { }
            }
            abandonTtsAudioFocusLocked();
            if (emitStoppedEvent && wasActive) {
                emitTtsState("stopped", null);
            }
        }
    }

    private void shutdownTts() {
        stopTtsInternal(false);
        synchronized (ttsLock) {
            ttsInitGeneration++;
            ttsMainHandler.removeCallbacksAndMessages(null);
            ttsInitializing = false;
            ttsReady = false;
            if (tts != null) {
                try { tts.shutdown(); } catch (RuntimeException ignored) { }
                tts = null;
            }
        }
    }

    private void emitTtsState(String status, String message) {
        JSObject data = new JSObject();
        data.put("status", status);
        if (message != null && !message.isEmpty()) {
            data.put("message", message);
        }
        notifyListeners("ttsState", data);
    }

    private static TtsUtteranceRef parseTtsUtteranceId(String utteranceId) {
        if (utteranceId == null || !utteranceId.startsWith("imcodes_tts_")) return null;
        String[] parts = utteranceId.substring("imcodes_tts_".length()).split("_");
        if (parts.length != 3) return null;
        try {
            return new TtsUtteranceRef(Long.parseLong(parts[0]), Integer.parseInt(parts[1]));
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private static final class TtsUtteranceRef {
        final long sessionId;
        final int chunkIndex;

        TtsUtteranceRef(long sessionId, int chunkIndex) {
            this.sessionId = sessionId;
            this.chunkIndex = chunkIndex;
        }
    }

    private static final class PendingSpeakRequest {
        final PluginCall call;
        final long sessionId;
        final String text;
        final String lang;
        final float rate;

        PendingSpeakRequest(PluginCall call, long sessionId, String text, String lang, float rate) {
            this.call = call;
            this.sessionId = sessionId;
            this.text = text;
            this.lang = lang;
            this.rate = rate;
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopCapture(false);
        worker.execute(call::resolve); // Capture finally/decoder release precede acknowledgement.
    }

    @Override
    protected void handleOnPause() {
        stopCapture(false);
        stopTtsInternal(true);
    }

    @Override
    protected void handleOnDestroy() {
        stopCapture(true);
        shutdownTts();
        worker.execute(() -> {
            if (decoder != null) {
                decoder.close();
                decoder = null;
            }
        });
        worker.shutdown();
    }
}
