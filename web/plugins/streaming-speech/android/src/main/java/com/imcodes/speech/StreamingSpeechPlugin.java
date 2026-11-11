package com.imcodes.speech;

import android.Manifest;
import androidx.lifecycle.Lifecycle;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.k2fsa.sherpa.onnx.OfflinePunctuation;
import com.k2fsa.sherpa.onnx.OfflinePunctuationConfig;
import com.k2fsa.sherpa.onnx.OfflinePunctuationModelConfig;
import com.k2fsa.sherpa.onnx.OnlineRecognizer;
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig;
import com.k2fsa.sherpa.onnx.OnlineStream;
import java.io.IOException;
import java.util.ArrayDeque;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Pattern;

/** Audio never leaves this device. One serial worker owns all native decoder state. */
@CapacitorPlugin(name = "StreamingSpeech", permissions = {
    @Permission(alias = "speechRecognition", strings = { Manifest.permission.RECORD_AUDIO })
})
public class StreamingSpeechPlugin extends Plugin {
    private static final int SAMPLE_RATE = 16000;
    private static final int MAX_BUFFERED_CHUNKS = 64; // ~6.4s at 100ms/chunk (matches iOS slots = 64)
    private static final Pattern PUNCT_STRIP = Pattern.compile("[，。？！、；：,.?!;:…—\\-]+");
    private static final Pattern PUNCT_END_BEFORE_COMMA = Pattern.compile("([。？！?!])([，,、]+)");
    private static final Pattern PUNCT_COMMA_BEFORE_END = Pattern.compile("([，,、]+)([。？！?!])");
    private static final Pattern PUNCT_DUP_COMMA = Pattern.compile("[，,、]{2,}");
    private static final Pattern PUNCT_DUP_PERIOD = Pattern.compile("[。]{2,}");
    private static final Pattern PUNCT_DUP_QUESTION = Pattern.compile("[？?]{2,}");
    private static final Pattern PUNCT_ASCII_PERIOD = Pattern.compile("([A-Za-z0-9])。");
    private static final Pattern PUNCT_ASCII_COMMA = Pattern.compile("([A-Za-z0-9])，");
    private static final Pattern PUNCT_ASCII_QUESTION = Pattern.compile("([A-Za-z0-9])？");
    private static final Pattern PUNCT_ASCII_EXCLAM = Pattern.compile("([A-Za-z0-9])！");
    private static final Pattern PUNCT_TRAILING_PERIOD = Pattern.compile("[。\\.\\s]+$");
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicLong generation = new AtomicLong();
    private final Object captureLock = new Object();
    private OnlineRecognizer recognizer;
    private OfflinePunctuation punctuator;
    private String lastCleanInput = "";
    private String lastPunctuatedFull = "";
    private CaptureSession activeSession;
    private volatile AudioRecord recorder;
    private volatile boolean listening;

    @Override
    public void load() {
        worker.execute(() -> {
            try {
                ensureRecognizer();
                ensurePunctuator();
            } catch (Exception | LinkageError ignored) {
                // Deferred to start() where initialization errors surface to the caller.
            }
        });
    }

    private OnlineRecognizer ensureRecognizer() {
        if (recognizer != null) return recognizer;
        OnlineRecognizerConfig config = new OnlineRecognizerConfig();
        config.getModelConfig().getTransducer().setEncoder("encoder.int8.onnx");
        config.getModelConfig().getTransducer().setDecoder("decoder.onnx");
        config.getModelConfig().getTransducer().setJoiner("joiner.int8.onnx");
        config.getModelConfig().setTokens("tokens.txt");
        config.getModelConfig().setModelType("zipformer");
        config.getModelConfig().setModelingUnit("cjkchar+bpe");
        config.getModelConfig().setBpeVocab("bpe.vocab");
        config.getModelConfig().setNumThreads(2);
        config.setDecodingMethod("modified_beam_search");
        config.setHotwordsFile("hotwords.txt");
        config.setHotwordsScore(2.0f);
        config.getEndpointConfig().getRule2().setMinTrailingSilence(1.2f);
        config.getEndpointConfig().getRule3().setMinUtteranceLength(30.0f);
        OnlineRecognizer created = new OnlineRecognizer(getContext().getAssets(), config);
        OnlineStream warmStream = created.createStream("");
        try {
            warmStream.acceptWaveform(new float[SAMPLE_RATE / 2], SAMPLE_RATE);
            decodeAvailable(created, warmStream);
        } finally {
            warmStream.release();
        }
        recognizer = created;
        return recognizer;
    }

    private OfflinePunctuation ensurePunctuator() {
        if (punctuator != null) return punctuator;
        OfflinePunctuationModelConfig model = new OfflinePunctuationModelConfig();
        model.setCtTransformer("punct.int8.onnx");
        model.setNumThreads(2);
        model.setDebug(false);
        model.setProvider("cpu");
        OfflinePunctuationConfig config = new OfflinePunctuationConfig(model);
        OfflinePunctuation created = new OfflinePunctuation(getContext().getAssets(), config);
        created.addPunctuation("你好世界");
        punctuator = created;
        return punctuator;
    }

    private void decodeAvailable(OnlineRecognizer recognizer, OnlineStream stream) {
        while (recognizer.isReady(stream)) recognizer.decode(stream);
    }

    @PluginMethod
    public void available(PluginCall call) {
        boolean ready = true;
        for (String name : new String[] { "encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx", "tokens.txt", "bpe.vocab", "hotwords.txt", "punct.int8.onnx" }) {
            try (java.io.InputStream input = getContext().getAssets().open(name)) {
                if (input.read() < 0) ready = false;
            } catch (IOException e) { ready = false; }
        }
        JSObject result = new JSObject(); result.put("available", ready); call.resolve(result);
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
            call.reject("Microphone permission denied"); return;
        }
        begin(call);
    }

    private void begin(PluginCall call) {
        if (worker.isShutdown() || !getActivity().getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED)) {
            call.reject("Speech requires a foreground app"); return;
        }
        synchronized (captureLock) {
            if (listening) { call.resolve(); return; }
            int min = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (min <= 0) {
                call.reject("Offline speech could not start", new IOException("Microphone format unavailable"));
                return;
            }
            // Buffer at least 6 seconds of 16kHz 16-bit mono PCM (~192KB) so speech captured
            // while the worker thread finishes warming up the model is never lost.
            int bufferSizeInBytes = Math.max(min * 2, SAMPLE_RATE * 2 * 6);
            AudioRecord audio = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufferSizeInBytes);
            if (audio.getState() != AudioRecord.STATE_INITIALIZED) {
                audio.release();
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
            CaptureSession session = new CaptureSession(owner, audio);
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

    private void runReader(CaptureSession session) {
        short[] pcm = new short[1600]; // 100ms chunks; bounded in-memory queue survives stop-before-warmup.
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
                float[] samples = new float[count];
                double power = 0;
                for (int i = 0; i < count; i++) {
                    samples[i] = pcm[i] / 32768.0f;
                    power += samples[i] * samples[i];
                }
                double levelValue = Math.min(1, Math.sqrt(power / count) * 3);
                if (!session.offerSamples(samples, () -> {
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
                try { session.audio.stop(); } catch (IllegalStateException ignored) { }
                session.audio.release();
                if (recorder == session.audio) recorder = null;
            }
            session.finishReader();
        }
    }

    private void capture(PluginCall call, long owner, AudioRecord audio, CaptureSession session) {
        OnlineRecognizer recognizer = null;
        OfflinePunctuation punctuator = null;
        OnlineStream stream = null;
        String committed = "", last = "", prevClean = "";
        int unchangedSilentChunks = 0;
        lastCleanInput = "";
        lastPunctuatedFull = "";
        boolean failed = false;
        try {
            if (session.isDiscarded() || generation.get() != owner) return;
            recognizer = ensureRecognizer();
            if (session.isDiscarded() || generation.get() != owner) return;
            punctuator = ensurePunctuator();
            if (session.isDiscarded() || generation.get() != owner) return;
            stream = recognizer.createStream("");
            // Half-second left-context padding establishes the acoustic alignment baseline.
            stream.acceptWaveform(new float[SAMPLE_RATE / 2], SAMPLE_RATE);
            decodeAvailable(recognizer, stream);
            while (!session.isDiscarded() && generation.get() == owner) {
                float[] samples = session.pollSamples(generation);
                if (samples == null) break;
                double level = computeLevel(samples);
                stream.acceptWaveform(samples, SAMPLE_RATE);
                decodeAvailable(recognizer, stream);
                String text = recognizer.getResult(stream).getText().trim();
                String rawFull = join(committed, text);
                String clean = stripPunctuation(rawFull);
                boolean endpoint = recognizer.isEndpoint(stream);
                if (clean.isEmpty()) {
                    unchangedSilentChunks = 0;
                } else if (!clean.equals(prevClean)) {
                    prevClean = clean;
                    unchangedSilentChunks = endpoint ? 3 : 0;
                } else if (endpoint) {
                    unchangedSilentChunks = Math.max(unchangedSilentChunks, 3);
                } else if (level < 0.08) {
                    unchangedSilentChunks++;
                } else if (unchangedSilentChunks < 3) {
                    unchangedSilentChunks = 0;
                }
                boolean allowTrailingPeriod = endpoint || unchangedSilentChunks >= 3;
                String full = punctuate(rawFull, punctuator, allowTrailingPeriod);
                if (!full.equals(last)) { partial(full, false); last = full; }
                if (endpoint) {
                    // Reset keeps transducer encoder context; a fresh stream prevents
                    // the next utterance from losing its first words after a pause.
                    OnlineStream next = recognizer.createStream("");
                    // Half-second left-context padding establishes the acoustic alignment baseline.
                    next.acceptWaveform(new float[SAMPLE_RATE / 2], SAMPLE_RATE);
                    decodeAvailable(recognizer, next);
                    stream.release();
                    stream = next;
                    committed = rawFull;
                    prevClean = clean;
                    unchangedSilentChunks = Math.max(unchangedSilentChunks, 3);
                }
            }
        } catch (Exception | LinkageError e) {
            failed = true;
            session.stopIntake();
            if (!session.isDiscarded() && generation.get() == owner) {
                String message = "Offline speech processing overloaded".equals(e.getMessage())
                    ? "Offline speech processing overloaded"
                    : "Offline speech interrupted";
                JSObject error = new JSObject(); error.put("message", message);
                notifyListeners("recognitionError", error);
            }
        } finally {
            session.stopIntake();
            // Normal stop before or after warmup drains all accepted PCM and flushes the final right-context window.
            if (!failed && !session.isDiscarded() && generation.get() == owner && stream != null && recognizer != null) {
                try {
                    // One second covers the transducer's final right-context window.
                    stream.acceptWaveform(new float[SAMPLE_RATE], SAMPLE_RATE);
                    stream.inputFinished();
                    decodeAvailable(recognizer, stream);
                    String rawFinal = join(committed, recognizer.getResult(stream).getText().trim());
                    partial(punctuate(rawFinal, punctuator, true), true);
                } catch (Exception | LinkageError ignored) { /* still release microphone/stream */ }
            }
            synchronized (captureLock) {
                if (audio != null) {
                    try { audio.stop(); } catch (IllegalStateException ignored) { }
                    audio.release();
                }
                if (recorder == audio) recorder = null;
                if (activeSession == session) {
                    activeSession = null;
                    listening = false;
                }
            }
            if (stream != null) stream.release();
            if (!session.isDiscarded() && generation.get() == owner) state("stopped");
        }
    }

    private static double computeLevel(float[] samples) {
        if (samples.length == 0) return 0;
        double power = 0;
        for (float s : samples) power += s * s;
        return Math.min(1, Math.sqrt(power / samples.length) * 3);
    }

    private static String stripPunctuation(String text) {
        if (text == null || text.isEmpty()) return "";
        return PUNCT_STRIP.matcher(text).replaceAll("").trim();
    }

    private static String formatBilingualPunctuation(String text) {
        if (text == null || text.isEmpty()) return "";
        String out = PUNCT_END_BEFORE_COMMA.matcher(text).replaceAll("$1");
        out = PUNCT_COMMA_BEFORE_END.matcher(out).replaceAll("$2");
        out = PUNCT_DUP_COMMA.matcher(out).replaceAll("，");
        out = PUNCT_DUP_PERIOD.matcher(out).replaceAll("。");
        out = PUNCT_DUP_QUESTION.matcher(out).replaceAll("？");
        out = PUNCT_ASCII_PERIOD.matcher(out).replaceAll("$1.");
        out = PUNCT_ASCII_COMMA.matcher(out).replaceAll("$1, ");
        out = PUNCT_ASCII_QUESTION.matcher(out).replaceAll("$1?");
        out = PUNCT_ASCII_EXCLAM.matcher(out).replaceAll("$1!");
        return out;
    }

    private String punctuate(String rawText, OfflinePunctuation punctuator, boolean allowTrailingPeriod) {
        String clean = stripPunctuation(rawText);
        if (clean.isEmpty()) return "";
        if (punctuator == null) return clean;
        String punctuated;
        if (clean.equals(lastCleanInput)) {
            punctuated = lastPunctuatedFull;
        } else {
            String rawPunct = punctuator.addPunctuation(clean);
            punctuated = formatBilingualPunctuation(rawPunct != null ? rawPunct : clean);
            lastCleanInput = clean;
            lastPunctuatedFull = punctuated;
        }
        if (allowTrailingPeriod) {
            return punctuated.trim();
        }
        return PUNCT_TRAILING_PERIOD.matcher(punctuated).replaceAll("");
    }

    private static final class CaptureSession {
        final long owner;
        final AudioRecord audio;
        private final ArrayDeque<float[]> pcmQueue = new ArrayDeque<>();
        private final CountDownLatch readerStarted = new CountDownLatch(1);
        private final CountDownLatch firstPassDone = new CountDownLatch(1);
        private boolean stopRequested;
        private boolean discarded;
        private boolean readerDone;
        private boolean overflowed;
        private Exception readError;

        CaptureSession(long owner, AudioRecord audio) {
            this.owner = owner;
            this.audio = audio;
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

        synchronized boolean offerSamples(float[] samples, Runnable onAccepted) {
            if (discarded) return false;
            if (pcmQueue.size() >= MAX_BUFFERED_CHUNKS) {
                overflowed = true;
                stopRequested = true;
                notifyAll();
                return false;
            }
            onAccepted.run();
            pcmQueue.addLast(samples);
            notifyAll();
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

        synchronized float[] pollSamples(AtomicLong generation) throws Exception {
            while (pcmQueue.isEmpty() && !readerDone && !discarded && generation.get() == owner) {
                wait();
            }
            if (discarded || generation.get() != owner) return null;
            if (overflowed) {
                throw new IOException("Offline speech processing overloaded");
            }
            if (!pcmQueue.isEmpty()) {
                return pcmQueue.removeFirst();
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
                pcmQueue.clear();
                notifyAll();
            }
            try {
                audio.stop();
            } catch (IllegalStateException ignored) {
            }
        }
    }

    private static String join(String previous, String text) {
        if (previous.isEmpty()) return text;
        if (text.isEmpty()) return previous;
        boolean asciiBoundary = previous.charAt(previous.length() - 1) < 128 && text.charAt(0) < 128;
        return previous + (asciiBoundary ? " " : "") + text;
    }
    private void partial(String text, boolean isFinal) {
        JSObject result = new JSObject(); result.put("matches", new JSArray().put(text)); result.put("isFinal", isFinal);
        notifyListeners("partialResults", result);
    }
    private void state(String status) {
        JSObject result = new JSObject(); result.put("status", status); notifyListeners("listeningState", result);
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
    @Override protected void handleOnPause() { stopCapture(false); }
    @Override protected void handleOnDestroy() {
        stopCapture(true);
        worker.execute(() -> {
            if (punctuator != null) {
                punctuator.release();
                punctuator = null;
            }
            if (recognizer != null) {
                recognizer.release();
                recognizer = null;
            }
        });
        worker.shutdown();
    }
}
