package com.imcodes.speech;

import android.Manifest;
import androidx.lifecycle.Lifecycle;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.audiofx.AudioEffect;
import android.media.audiofx.AutomaticGainControl;
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
import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
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
    private static final String MODEL_CACHE_DIR = "qwen3-asr-9012f07ac1ce43c7e9fbd3afd8cad90fe147f88e";
    private static final String[] MODEL_FILES = {
        "conv_frontend.onnx",
        "encoder.int4.onnx",
        "encoder.int4.weights",
        "decoder.int4.onnx",
        "decoder.int4.weights",
        "tokenizer/vocab.json",
        "tokenizer/merges.txt",
        "tokenizer/tokenizer_config.json",
        "hotwords.txt"
    };

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicLong generation = new AtomicLong();
    private final Object captureLock = new Object();
    private Qwen3OnnxDecoder decoder;
    private volatile Boolean cachedAssetsAvailable;
    private CaptureSession activeSession;
    private volatile AudioRecord recorder;
    private volatile boolean listening;

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
        // Publish complete files into this model revision's private no-backup cache.
        File root = new File(getContext().getNoBackupFilesDir(), MODEL_CACHE_DIR);
        for (String name : MODEL_FILES) {
            File file = new File(root, name);
            if (!file.getParentFile().isDirectory() && !file.getParentFile().mkdirs()) {
                throw new IOException("Speech cache directory unavailable");
            }
            try (java.io.InputStream input = getContext().getAssets().open(name)) {
                if (file.isFile() && file.length() == input.available() && file.length() > 0) continue;
                File pending = new File(file.getPath() + ".part");
                try {
                    try (FileOutputStream output = new FileOutputStream(pending)) {
                        byte[] buffer = new byte[65536];
                        int count;
                        while ((count = input.read(buffer)) != -1) {
                            output.write(buffer, 0, count);
                        }
                    }
                    if (!pending.renameTo(file)) throw new IOException("Speech cache publish failed");
                } finally {
                    pending.delete();
                }
            }
        }
        String hotwords = "";
        try (BufferedReader reader = new BufferedReader(
            new InputStreamReader(getContext().getAssets().open("hotwords.txt"), StandardCharsets.UTF_8)
        )) {
            hotwords = String.join(
                " ",
                reader.lines().map(String::trim).filter(line -> !line.isEmpty()).toArray(String[]::new)
            );
        }
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
            boolean ready = true;
            for (String name : MODEL_FILES) {
                try (java.io.InputStream input = getContext().getAssets().open(name)) {
                    if (!name.equals("hotwords.txt") && input.read() < 0) ready = false;
                } catch (IOException e) {
                    ready = false;
                }
            }
            cached = ready;
            cachedAssetsAvailable = cached;
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
            AutomaticGainControl agc = attachAutomaticGainControl(audio);
            try {
                audio.startRecording();
            } catch (IllegalStateException e) {
                releaseAutomaticGainControl(agc);
                audio.release();
                call.reject("Offline speech could not start", e);
                return;
            }
            if (audio.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                releaseAutomaticGainControl(agc);
                try { audio.stop(); } catch (IllegalStateException ignored) { }
                audio.release();
                call.reject("Offline speech could not start", new IOException("Microphone start failed"));
                return;
            }
            long owner = generation.incrementAndGet();
            String language = Qwen3OnnxDecoder.resolveLanguage(call.getString("language"));
            CaptureSession session = new CaptureSession(owner, audio, agc, language);
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
        int[] sources = {
            MediaRecorder.AudioSource.MIC,
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
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

    private static AutomaticGainControl attachAutomaticGainControl(AudioRecord audio) {
        try {
            if (!AutomaticGainControl.isAvailable()) {
                return null;
            }
            AutomaticGainControl effect = AutomaticGainControl.create(audio.getAudioSessionId());
            if (effect == null) {
                return null;
            }
            try {
                if (effect.setEnabled(true) != AudioEffect.SUCCESS) {
                    effect.release();
                    return null;
                }
                return effect;
            } catch (RuntimeException ignored) {
                try { effect.release(); } catch (RuntimeException ignoredRelease) { }
                return null;
            }
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static void releaseAutomaticGainControl(AutomaticGainControl agc) {
        if (agc == null) {
            return;
        }
        try { agc.setEnabled(false); } catch (Throwable ignored) { }
        try { agc.release(); } catch (Throwable ignored) { }
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
            final Qwen3OnnxDecoder dec = activeDecoder;
            final Qwen3SpeechWindow.RollbackFn rollbackFn = dec::safePrefixTokensForRollback;
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
                    String full = window.finish(
                        () -> !session.isDiscarded() && generation.get() == owner,
                        dec::safePrefixTokensForRollback,
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
        final boolean finalTail;

        AudioBatch(float[] samples, boolean speech, int trailingSilence, boolean finalTail) {
            this.samples = samples;
            this.speech = speech;
            this.trailingSilence = trailingSilence;
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
        private AutomaticGainControl agc;
        private boolean audioReleased;
        private boolean stopRequested;
        private boolean discarded;
        private boolean readerDone;
        private boolean overflowed;
        private Exception readError;

        CaptureSession(long owner, AudioRecord audio, AutomaticGainControl agc, String language) {
            this.owner = owner;
            this.audio = audio;
            this.agc = agc;
            this.language = language;
        }

        synchronized void releaseAudioResources() {
            if (audioReleased) return;
            audioReleased = true;
            releaseAutomaticGainControl(agc);
            agc = null;
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
                return new AudioBatch(batch.samples, batch.speech, batch.trailingSilence, stopRequested && readerDone);
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
    public void stop(PluginCall call) {
        stopCapture(false);
        worker.execute(call::resolve); // Capture finally/decoder release precede acknowledgement.
    }

    @Override
    protected void handleOnPause() {
        stopCapture(false);
    }

    @Override
    protected void handleOnDestroy() {
        stopCapture(true);
        worker.execute(() -> {
            if (decoder != null) {
                decoder.close();
                decoder = null;
            }
        });
        worker.shutdown();
    }
}
