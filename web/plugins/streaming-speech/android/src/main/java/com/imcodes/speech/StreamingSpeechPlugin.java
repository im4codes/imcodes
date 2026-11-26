package com.imcodes.speech;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import androidx.lifecycle.Lifecycle;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.util.Base64;
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
    private static final int MAX_PREFILL_SAMPLES = SAMPLE_RATE * 30; // 30s @ 16kHz Int16
    private static final int READ_CHUNK_SAMPLES = 800; // 50ms chunks matching iOS 20fps audioLevel cadence
    private static final int RAW_PCM_CHUNK_SAMPLES = 1600; // 100ms chunks @ 16kHz
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
    private final Object rawPcmLock = new Object();
    private final AtomicLong rawPcmGeneration = new AtomicLong();
    private volatile boolean rawPcmCapturing = false;
    private AudioRecord rawPcmRecorder;
    private Thread rawPcmThread;

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

    static boolean isActivityForegroundForSpeech(Lifecycle.State state) {
        return state != null && state.isAtLeast(Lifecycle.State.STARTED);
    }

    static float[] decodePcm16Base64(String base64) {
        if (base64 == null) return null;
        String trimmed = base64.trim();
        if (trimmed.isEmpty()) return new float[0];
        final byte[] bytes;
        try {
            bytes = Base64.decode(trimmed, Base64.DEFAULT);
        } catch (IllegalArgumentException ignored) {
            return null;
        }
        return Qwen3SpeechWindow.decodePcm16LittleEndian(bytes);
    }

    private void begin(PluginCall call) {
        Lifecycle.State lifecycleState = getActivity() != null ? getActivity().getLifecycle().getCurrentState() : null;
        if (worker.isShutdown() || !isActivityForegroundForSpeech(lifecycleState)) {
            call.reject("Speech requires a foreground app");
            return;
        }
        String rawInitialPcm = call.getString("initialPcmBase64");
        float[] initialSamples = new float[0];
        if (rawInitialPcm != null && !rawInitialPcm.trim().isEmpty()) {
            float[] decoded = decodePcm16Base64(rawInitialPcm);
            if (decoded == null) {
                call.reject("Invalid initialPcmBase64");
                return;
            }
            if (decoded.length > MAX_PREFILL_SAMPLES) {
                initialSamples = new float[MAX_PREFILL_SAMPLES];
                System.arraycopy(decoded, decoded.length - MAX_PREFILL_SAMPLES, initialSamples, 0, MAX_PREFILL_SAMPLES);
            } else {
                initialSamples = decoded;
            }
        }
        stopTtsInternal(true);
        stopRawPcmCaptureInternal(false);
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
            preferBuiltInMic(audio);
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
            int warmupSamples = initialSamples.length == 0
                ? Qwen3SpeechWindow.SpeechInbox.WARMUP_SAMPLES
                : 0;
            CaptureSession session = new CaptureSession(owner, audio, language, warmupSamples);
            if (initialSamples.length > 0) {
                // Offer pre-fallback audio before reader thread starts so it stays strictly
                // ahead of live AudioRecord samples with zero warmup clipping.
                session.offerSamples(initialSamples, initialSamples.length, ignored -> {});
            }
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

    @PluginMethod
    public void transcribePcm(PluginCall call) {
        String rawPcm = call.getString("pcmBase64");
        if (rawPcm == null || rawPcm.trim().isEmpty()) {
            JSObject empty = new JSObject();
            empty.put("text", "");
            call.resolve(empty);
            return;
        }
        float[] samples = decodePcm16Base64(rawPcm);
        if (samples == null) {
            call.reject("Invalid pcmBase64");
            return;
        }
        if (samples.length == 0) {
            JSObject empty = new JSObject();
            empty.put("text", "");
            call.resolve(empty);
            return;
        }
        Lifecycle.State lifecycleState = getActivity() != null ? getActivity().getLifecycle().getCurrentState() : null;
        if (worker.isShutdown() || !isActivityForegroundForSpeech(lifecycleState)) {
            call.reject("Speech requires a foreground app");
            return;
        }
        String language = Qwen3OnnxDecoder.resolveLanguage(call.getString("language"));
        worker.execute(() -> {
            Qwen3OnnxDecoder activeDecoder = null;
            try {
                if (worker.isShutdown()) {
                    call.reject("Speech requires a foreground app");
                    return;
                }
                activeDecoder = ensureDecoder();
                activeDecoder.resetStreamingCache();
                final Qwen3OnnxDecoder dec = activeDecoder;
                final boolean expectLanguageHeader = Qwen3OnnxDecoder.resolveLanguage(language) == null;
                String text = Qwen3SpeechWindow.transcribeOfflineSamples(
                    samples,
                    (tokens, rollbackCount) -> dec.safePrefixTokensForRollback(tokens, rollbackCount, expectLanguageHeader),
                    (pcm, count, prefixTokens) -> {
                        if (count == 0) return new Qwen3SpeechWindow.DecodeResult("", new int[0]);
                        try {
                            return dec.transcribe(pcm, count, prefixTokens, language, () -> !worker.isShutdown());
                        } catch (OrtException e) {
                            throw new Qwen3SpeechWindow.DecodeException(e.getMessage());
                        }
                    },
                    () -> !worker.isShutdown()
                );
                JSObject result = new JSObject();
                result.put("text", text != null ? text : "");
                call.resolve(result);
            } catch (Qwen3SpeechWindow.CancelledException ignored) {
                call.reject("Speech requires a foreground app");
            } catch (Exception | LinkageError e) {
                call.reject("Offline speech decoding failed");
            } finally {
                if (activeDecoder != null) {
                    activeDecoder.resetStreamingCache();
                }
            }
        });
    }

    static AudioDeviceInfo selectBuiltInMicDevice(AudioDeviceInfo[] inputs) {
        if (inputs == null) return null;
        for (AudioDeviceInfo device : inputs) {
            if (device != null && device.getType() == AudioDeviceInfo.TYPE_BUILTIN_MIC) {
                return device;
            }
        }
        return null;
    }

    private void preferBuiltInMic(AudioRecord candidate) {
        if (candidate == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        android.content.Context context = getContext();
        if (context == null) return;
        Object service = context.getApplicationContext().getSystemService(android.content.Context.AUDIO_SERVICE);
        if (!(service instanceof AudioManager)) return;
        AudioManager am = (AudioManager) service;
        AudioDeviceInfo builtIn = selectBuiltInMicDevice(am.getDevices(AudioManager.GET_DEVICES_INPUTS));
        if (builtIn != null) {
            candidate.setPreferredDevice(builtIn);
        }
    }

    static byte[] shortsToLittleEndianBytes(short[] pcm, int count) {
        byte[] bytes = new byte[count * 2];
        for (int i = 0; i < count; i++) {
            short s = pcm[i];
            bytes[i * 2] = (byte) (s & 0xff);
            bytes[i * 2 + 1] = (byte) ((s >> 8) & 0xff);
        }
        return bytes;
    }

    static double computeNormalizedPcmLevel(short[] pcm, int count) {
        if (pcm == null || count <= 0) return 0.0;
        double sum = 0.0;
        for (int i = 0; i < count; i++) {
            double normalized = pcm[i] / 32768.0;
            sum += normalized * normalized;
        }
        double rms = Math.sqrt(sum / count);
        return Math.min(1.0, Math.max(0.0, rms * 3.0));
    }

    @PluginMethod
    public void startRawPcmCapture(PluginCall call) {
        if (getPermissionState("speechRecognition") != PermissionState.GRANTED) {
            requestPermissionForAlias("speechRecognition", call, "rawPcmPermission");
            return;
        }
        beginRawPcmCapture(call);
    }

    @PermissionCallback
    private void rawPcmPermission(PluginCall call) {
        if (getPermissionState("speechRecognition") != PermissionState.GRANTED) {
            call.reject("Microphone permission denied");
            return;
        }
        beginRawPcmCapture(call);
    }

    private void beginRawPcmCapture(PluginCall call) {
        Lifecycle.State lifecycleState = getActivity() != null ? getActivity().getLifecycle().getCurrentState() : null;
        if (worker.isShutdown() || !isActivityForegroundForSpeech(lifecycleState)) {
            call.reject("Speech requires a foreground app");
            return;
        }
        stopTtsInternal(true);
        stopCapture(true);
        stopRawPcmCaptureInternal(false);

        int min = AudioRecord.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        );
        if (min <= 0) {
            call.reject("Raw PCM capture could not start", new IOException("Microphone format unavailable"));
            return;
        }
        int bufferSizeInBytes = Math.max(min * 2, SAMPLE_RATE * 2 * 4);
        AudioRecord audio = createAudioRecord(bufferSizeInBytes);
        if (audio == null) {
            call.reject("Raw PCM capture could not start", new IOException("Microphone initialization failed"));
            return;
        }
        preferBuiltInMic(audio);
        try {
            audio.startRecording();
        } catch (IllegalStateException e) {
            audio.release();
            call.reject("Raw PCM capture could not start", e);
            return;
        }
        if (audio.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
            try { audio.stop(); } catch (IllegalStateException ignored) { }
            audio.release();
            call.reject("Raw PCM capture could not start", new IOException("Microphone start failed"));
            return;
        }

        final long owner = rawPcmGeneration.incrementAndGet();
        final Thread reader;
        synchronized (rawPcmLock) {
            rawPcmRecorder = audio;
            rawPcmCapturing = true;
            reader = new Thread(() -> runRawPcmReader(owner, audio), "imcodes-raw-pcm-" + owner);
            reader.setDaemon(true);
            rawPcmThread = reader;
        }
        reader.start();
        call.resolve();
    }

    private void emitRawPcmChunk(short[] samples, int count) {
        if (count <= 0) return;
        byte[] bytes = shortsToLittleEndianBytes(samples, count);
        JSObject payload = new JSObject();
        payload.put("pcmBase64", Base64.encodeToString(bytes, Base64.NO_WRAP));
        payload.put("level", computeNormalizedPcmLevel(samples, count));
        notifyListeners("rawPcmChunk", payload);
    }

    private void runRawPcmReader(long owner, AudioRecord audio) {
        short[] readBuf = new short[READ_CHUNK_SAMPLES];
        short[] chunkBuf = new short[RAW_PCM_CHUNK_SAMPLES];
        int chunkOffset = 0;
        try {
            while (rawPcmCapturing && rawPcmGeneration.get() == owner) {
                int count = audio.read(readBuf, 0, readBuf.length, AudioRecord.READ_BLOCKING);
                if (count <= 0) break;
                int offset = 0;
                while (offset < count) {
                    int take = Math.min(RAW_PCM_CHUNK_SAMPLES - chunkOffset, count - offset);
                    System.arraycopy(readBuf, offset, chunkBuf, chunkOffset, take);
                    chunkOffset += take;
                    offset += take;
                    if (chunkOffset >= RAW_PCM_CHUNK_SAMPLES) {
                        if (rawPcmCapturing && rawPcmGeneration.get() == owner) {
                            emitRawPcmChunk(chunkBuf, RAW_PCM_CHUNK_SAMPLES);
                        }
                        chunkOffset = 0;
                    }
                }
            }
            if (chunkOffset > 0 && rawPcmGeneration.get() == owner) {
                emitRawPcmChunk(chunkBuf, chunkOffset);
            }
        } catch (Exception ignored) {
            // Stopping AudioRecord unblocks reads cleanly.
        } finally {
            synchronized (rawPcmLock) {
                if (rawPcmRecorder == audio) {
                    rawPcmRecorder = null;
                    rawPcmCapturing = false;
                }
                if (rawPcmThread == Thread.currentThread()) {
                    rawPcmThread = null;
                }
            }
            try { audio.stop(); } catch (IllegalStateException ignored) { }
            audio.release();
        }
    }

    @PluginMethod
    public void stopRawPcmCapture(PluginCall call) {
        stopRawPcmCaptureInternal(true);
        call.resolve();
    }

    private void stopRawPcmCaptureInternal(boolean flushTail) {
        AudioRecord toStop;
        Thread toJoin;
        synchronized (rawPcmLock) {
            if (!flushTail) {
                rawPcmGeneration.incrementAndGet();
            }
            rawPcmCapturing = false;
            toStop = rawPcmRecorder;
            toJoin = rawPcmThread;
        }
        if (toStop != null) {
            try { toStop.stop(); } catch (IllegalStateException ignored) { }
        }
        if (toJoin != null && toJoin != Thread.currentThread()) {
            try {
                toJoin.join(300L);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }
        if (flushTail) {
            rawPcmGeneration.incrementAndGet();
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
        private final Qwen3SpeechWindow.SpeechInbox inbox;
        private final CountDownLatch readerStarted = new CountDownLatch(1);
        private final CountDownLatch firstPassDone = new CountDownLatch(1);
        private boolean audioReleased;
        private boolean stopRequested;
        private boolean discarded;
        private boolean readerDone;
        private boolean overflowed;
        private Exception readError;

        CaptureSession(long owner, AudioRecord audio, String language) {
            this(owner, audio, language, Qwen3SpeechWindow.SpeechInbox.WARMUP_SAMPLES);
        }

        CaptureSession(long owner, AudioRecord audio, String language, int warmupSamples) {
            this.owner = owner;
            this.audio = audio;
            this.language = language;
            this.inbox = warmupSamples == Qwen3SpeechWindow.SpeechInbox.WARMUP_SAMPLES
                ? new Qwen3SpeechWindow.SpeechInbox(new SpeechGain())
                : new Qwen3SpeechWindow.SpeechInbox(new SpeechGain(), warmupSamples);
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
        stopRawPcmCaptureInternal(false);

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

    @PluginMethod
    public void openTtsSettings(PluginCall call) {
        android.content.Context context = getContext();
        boolean opened = false;
        if (context != null) {
            String[] actions = new String[] {
                "com.android.settings.TTS_SETTINGS",
                TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA,
                Settings.ACTION_SETTINGS,
            };
            for (String action : actions) {
                try {
                    Intent intent = new Intent(action);
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    context.startActivity(intent);
                    opened = true;
                    break;
                } catch (ActivityNotFoundException | SecurityException ignored) {
                    // Try the next official fallback settings intent.
                } catch (RuntimeException ignored) {
                    // Defensive fallback for OEM ROM intent dispatch quirks.
                }
            }
        }
        JSObject result = new JSObject();
        result.put("opened", opened);
        call.resolve(result);
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        android.content.Context context = getContext();
        boolean opened = false;
        if (context != null) {
            Intent appDetailsIntent = new Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", context.getPackageName(), null)
            );
            Intent fallbackIntent = new Intent(Settings.ACTION_SETTINGS);
            for (Intent intent : new Intent[] { appDetailsIntent, fallbackIntent }) {
                try {
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    context.startActivity(intent);
                    opened = true;
                    break;
                } catch (ActivityNotFoundException | SecurityException ignored) {
                    // Try the next official fallback settings intent.
                } catch (RuntimeException ignored) {
                    // Defensive fallback for OEM ROM intent dispatch quirks.
                }
            }
        }
        JSObject result = new JSObject();
        result.put("opened", opened);
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
        stopRawPcmCaptureInternal(false);
        worker.execute(call::resolve); // Capture finally/decoder release precede acknowledgement.
    }

    @Override
    protected void handleOnPause() {
        stopCapture(false);
        stopRawPcmCaptureInternal(false);
    }

    @Override
    protected void handleOnDestroy() {
        stopCapture(true);
        stopRawPcmCaptureInternal(false);
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
