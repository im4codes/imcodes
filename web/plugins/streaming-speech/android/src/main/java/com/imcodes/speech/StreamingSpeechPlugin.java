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
import com.k2fsa.sherpa.onnx.OfflineRecognizer;
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig;
import com.k2fsa.sherpa.onnx.OfflineStream;
import java.io.IOException;
import java.io.File;
import java.io.FileOutputStream;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.ArrayDeque;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/** Audio never leaves this device. One serial worker owns all native decoder state. */
@CapacitorPlugin(name = "StreamingSpeech", permissions = {
    @Permission(alias = "speechRecognition", strings = { Manifest.permission.RECORD_AUDIO })
})
public class StreamingSpeechPlugin extends Plugin {
    private static final int SAMPLE_RATE = 16000;
    private static final int MAX_BUFFERED_CHUNKS = 320; // ~32s at 100ms/chunk (matches iOS 32s limit)
    private static final int STRIDE_SAMPLES = SAMPLE_RATE * 3 / 2; // 1.5s (24,000 samples)
    private static final int WINDOW_CAPACITY = 3 * STRIDE_SAMPLES; // 4.5s (72,000 samples)
    private static final int OVERLAP_SAMPLES = STRIDE_SAMPLES; // 1.5s (24,000 samples)
    private static final int FINAL_SILENCE_PADDING = SAMPLE_RATE * 2 / 10; // 200ms (3,200 zero samples)
    private static final int ROLLBACK_CHARS = 5;
    private static final int PUNCTUATION_PAUSE = SAMPLE_RATE * 4 / 10; // 400ms (6,400 samples)
    private static final int VAD_PAUSE = 9600; // 600ms (9,600 samples)
    private static final String[] MODEL_FILES = { "conv_frontend.onnx", "encoder.int4.onnx", "encoder.int4.weights", "decoder.int4.onnx", "decoder.int4.weights", "tokenizer/vocab.json", "tokenizer/merges.txt", "tokenizer/tokenizer_config.json", "hotwords.txt" };
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicLong generation = new AtomicLong();
    private final Object captureLock = new Object();
    private OfflineRecognizer recognizer;
    private CaptureSession activeSession;
    private volatile AudioRecord recorder;
    private volatile boolean listening;

    @Override
    public void load() {
        worker.execute(() -> {
            try {
                ensureRecognizer();
            } catch (Exception | LinkageError ignored) {
                // Deferred to start() where initialization errors surface to the caller.
            }
        });
    }

    private OfflineRecognizer ensureRecognizer() throws IOException {
        if (recognizer != null) return recognizer;
        // ORT cannot resolve external .weights from an in-memory Android asset.
        // Publish complete files into this model revision's private no-backup cache.
        File root = new File(getContext().getNoBackupFilesDir(), "qwen3-asr-9012f07ac1ce43c7e9fbd3afd8cad90fe147f88e");
        for (String name : MODEL_FILES) {
            File file = new File(root, name);
            if (!file.getParentFile().isDirectory() && !file.getParentFile().mkdirs()) throw new IOException("Speech cache directory unavailable");
            try (java.io.InputStream input = getContext().getAssets().open(name)) {
                if (file.isFile() && file.length() == input.available() && file.length() > 0) continue;
                File pending = new File(file.getPath() + ".part");
                try {
                    try (FileOutputStream output = new FileOutputStream(pending)) {
                        byte[] buffer = new byte[65536]; int count;
                        while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                    }
                    if (!pending.renameTo(file)) throw new IOException("Speech cache publish failed");
                } finally { pending.delete(); }
            }
        }
        OfflineRecognizerConfig config = new OfflineRecognizerConfig();
        var model = config.getModelConfig();
        model.setNumThreads(4);
        model.setProvider("cpu");
        var qwen = model.getQwen3Asr();
        qwen.setConvFrontend(new File(root, "conv_frontend.onnx").getPath());
        qwen.setEncoder(new File(root, "encoder.int4.onnx").getPath());
        qwen.setDecoder(new File(root, "decoder.int4.onnx").getPath());
        qwen.setTokenizer(new File(root, "tokenizer").getPath());
        qwen.setMaxTotalLen(768); qwen.setMaxNewTokens(24);
        qwen.setTemperature(1e-6f); qwen.setTopP(0.8f); qwen.setSeed(42);
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(getContext().getAssets().open("hotwords.txt"), StandardCharsets.UTF_8))) {
            qwen.setHotwords(String.join(",", reader.lines().map(String::trim).filter(line -> !line.isEmpty()).toArray(String[]::new)));
        }
        recognizer = new OfflineRecognizer(null, config);
        return recognizer;
    }

    private String decodeSamples(OfflineRecognizer recognizer, float[] samples, int count) {
        if (count == 0) return "";
        OfflineStream stream = recognizer.createStream();
        try {
            stream.acceptWaveform(Arrays.copyOf(samples, count), SAMPLE_RATE);
            recognizer.decode(stream);
            return recognizer.getResult(stream).getText().trim();
        } finally { stream.release(); }
    }

    @PluginMethod
    public void available(PluginCall call) {
        boolean ready = true;
        for (String name : MODEL_FILES) {
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
        OfflineRecognizer recognizer = null;
        SpeechWindow window = new SpeechWindow();
        boolean failed = false;
        try {
            if (session.isDiscarded() || generation.get() != owner) return;
            recognizer = ensureRecognizer();
            if (session.isDiscarded() || generation.get() != owner) return;
            final OfflineRecognizer activeRecognizer = recognizer;
            while (!session.isDiscarded() && generation.get() == owner) {
                AudioBatch batch = session.pollSamples(generation);
                if (batch == null) break;
                window.append(
                    batch.samples,
                    batch.speech,
                    batch.trailingSilence,
                    batch.finalTail,
                    (pcm, count) -> {
                        if (session.isDiscarded() || generation.get() != owner) return null;
                        return decodeSamples(activeRecognizer, pcm, count);
                    },
                    (text) -> {
                        if (!session.isDiscarded() && generation.get() == owner) {
                            partial(text, false);
                        }
                    }
                );
                if (batch.finalTail) break;
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
            // Normal stop drains every accepted PCM chunk before the final barrier.
            if (!failed && !session.isDiscarded() && generation.get() == owner && recognizer != null) {
                try {
                    final OfflineRecognizer activeRecognizer = recognizer;
                    String full = window.finish((pcm, count) -> decodeSamples(activeRecognizer, pcm, count));
                    if (!session.isDiscarded() && generation.get() == owner) partial(full, true);
                } catch (Exception | LinkageError error) {
                    JSObject failure = new JSObject(); failure.put("message", "Offline speech final decoding failed");
                    notifyListeners("recognitionError", failure);
                }
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
            if (!session.isDiscarded() && generation.get() == owner) state("stopped");
        }
    }

    private interface WindowDecoder {
        String decode(float[] samples, int count);
    }

    private interface WindowEmitter {
        void emit(String text);
    }

    private static final class SpeechWindow {
        private final float[] samples = new float[WINDOW_CAPACITY];
        private int sampleCount = 0;
        private int newSamples = 0;
        private int silentSamples = 0;
        private String committed = "";
        private String partial = "";
        private String anchor = "";
        private boolean rolling = false;
        private String seamTail = "";
        private String overlapText = null;
        private String overlapHint = null;
        private String lastGrowth = null;
        private String hypothesis = null;
        private String previousHypothesis = null;
        private String lastEmitted = "";

        String getText() {
            return rolling ? committed + partial : join(committed, partial);
        }

        void append(float[] input, boolean speech, int trailingSilence, boolean isFinal, WindowDecoder decoder, WindowEmitter emitter) {
            if (input.length == 0 || (sampleCount == 0 && !speech)) return;
            int offset = 0;
            int remaining = input.length;
            while (sampleCount + remaining > WINDOW_CAPACITY) {
                int takeCount = Math.max(1, WINDOW_CAPACITY - sampleCount);
                System.arraycopy(input, offset, samples, sampleCount, takeCount);
                offset += takeCount;
                remaining -= takeCount;
                sampleCount += takeCount;
                newSamples += takeCount;
                silentSamples = speech ? (remaining == 0 ? trailingSilence : 0) : silentSamples + takeCount;
                if (!evaluate(decoder, false)) return;
                int pause = endsSentence(partial) ? PUNCTUATION_PAUSE : VAD_PAUSE;
                if (silentSamples >= pause) commitSentence();
                else rollWindow();
                String current = getText();
                if (!isFinal && !current.equals(lastEmitted)) {
                    lastEmitted = current;
                    emitter.emit(current);
                }
            }
            if (remaining <= 0) return;
            System.arraycopy(input, offset, samples, sampleCount, remaining);
            sampleCount += remaining;
            newSamples += remaining;
            silentSamples = speech ? trailingSilence : silentSamples + remaining;
            if (isFinal) return;
            int pause = endsSentence(partial) ? PUNCTUATION_PAUSE : VAD_PAUSE;
            boolean endpoint = silentSamples >= pause;
            if (endpoint || newSamples >= STRIDE_SAMPLES || sampleCount >= WINDOW_CAPACITY) {
                if (!evaluate(decoder, false)) return;
                if (endpoint) commitSentence();
                else if (sampleCount >= WINDOW_CAPACITY) rollWindow();
                String current = getText();
                if (!current.equals(lastEmitted)) {
                    lastEmitted = current;
                    emitter.emit(current);
                }
            }
        }

        String finish(WindowDecoder decoder) {
            if (newSamples > 0) {
                evaluate(decoder, true);
            }
            commitSentence();
            return getText();
        }

        private boolean evaluate(WindowDecoder decoder, boolean padFinalSilence) {
            final String raw;
            if (padFinalSilence) {
                float[] padded = new float[sampleCount + FINAL_SILENCE_PADDING];
                System.arraycopy(samples, 0, padded, 0, sampleCount);
                raw = decoder.decode(padded, padded.length);
            } else {
                raw = decoder.decode(samples, sampleCount);
            }
            if (raw == null) return false;
            String next = raw.trim();
            previousHypothesis = hypothesis;
            hypothesis = next;
            int matched = 0;
            if (!rolling) {
                partial = next;
            } else {
                int size;
                if (overlapText != null && !overlapText.isEmpty() && next.startsWith(overlapText)) {
                    size = cpCount(overlapText);
                } else if (overlapHint != null && !overlapHint.isEmpty() && next.startsWith(overlapHint)) {
                    size = cpCount(overlapHint);
                } else {
                    size = overlapCount(anchor + seamTail, next);
                }
                matched = size;
                int seamTailLen = cpCount(seamTail);
                if (size > seamTailLen) {
                    partial = dropFirstCp(next, size - seamTailLen);
                } else if (size > 0) {
                    partial = dropLastCp(seamTail, size) + next;
                } else {
                    partial = join(seamTail, next);
                }
            }
            if (newSamples <= STRIDE_SAMPLES) {
                if (previousHypothesis != null) {
                    if (!next.equals(previousHypothesis)) {
                        lastGrowth = null;
                        if (next.startsWith(previousHypothesis)) {
                            String added = next.substring(previousHypothesis.length()).trim();
                            if (!added.isEmpty()) lastGrowth = added;
                        }
                    }
                } else {
                    String added = dropFirstCp(next, matched).trim();
                    if (!added.isEmpty()) lastGrowth = added;
                }
            } else {
                lastGrowth = null;
            }
            newSamples = 0;
            return true;
        }

        private void rollWindow() {
            overlapText = null;
            if (previousHypothesis != null && hypothesis != null
                && hypothesis.length() > previousHypothesis.length()
                && hypothesis.startsWith(previousHypothesis)) {
                String added = hypothesis.substring(previousHypothesis.length()).trim();
                if (!added.isEmpty()) overlapText = added;
            }
            overlapHint = null;
            if (lastGrowth != null && !lastGrowth.isEmpty() && hypothesis != null && hypothesis.endsWith(lastGrowth)) {
                overlapHint = lastGrowth;
            }
            hypothesis = null;
            previousHypothesis = null;
            String tail = suffixCp(partial, ROLLBACK_CHARS);
            int tailCp = cpCount(tail);
            String stable = dropLastCp(partial, tailCp);
            committed = rolling ? committed + stable : join(committed, stable);
            rolling = true;
            anchor = suffixCp(anchor + stable, 48);
            partial = tail;
            seamTail = tail;
            int keep = Math.min(sampleCount, OVERLAP_SAMPLES);
            if (keep > 0 && sampleCount > keep) {
                System.arraycopy(samples, sampleCount - keep, samples, 0, keep);
            }
            sampleCount = keep;
        }

        private void commitSentence() {
            committed = getText();
            partial = "";
            anchor = "";
            rolling = false;
            seamTail = "";
            overlapText = null;
            overlapHint = null;
            lastGrowth = null;
            hypothesis = null;
            previousHypothesis = null;
            sampleCount = 0;
            newSamples = 0;
            silentSamples = 0;
        }

        private static boolean endsSentence(String text) {
            if (text.isEmpty()) return false;
            int cp = text.codePointBefore(text.length());
            return "，、；,;.。！？!?".indexOf(cp) >= 0;
        }

        private static int overlapCount(String previous, String next) {
            int maxWindow = 48 + ROLLBACK_CHARS;
            String left = suffixCp(previous, maxWindow);
            String right = prefixCp(next, maxWindow);
            int limit = Math.min(cpCount(left), cpCount(right));
            for (int size = limit; size >= 1; size--) {
                if (suffixCp(left, size).equals(prefixCp(right, size))) {
                    return size;
                }
            }
            return 0;
        }

        private static int cpCount(String s) {
            return s.codePointCount(0, s.length());
        }

        private static String prefixCp(String s, int n) {
            int total = cpCount(s);
            if (n >= total) return s;
            if (n <= 0) return "";
            return s.substring(0, s.offsetByCodePoints(0, n));
        }

        private static String suffixCp(String s, int n) {
            int total = cpCount(s);
            if (n >= total) return s;
            if (n <= 0) return "";
            return s.substring(s.offsetByCodePoints(0, total - n));
        }

        private static String dropFirstCp(String s, int n) {
            int total = cpCount(s);
            if (n >= total) return "";
            if (n <= 0) return s;
            return s.substring(s.offsetByCodePoints(0, n));
        }

        private static String dropLastCp(String s, int n) {
            int total = cpCount(s);
            if (n >= total) return "";
            if (n <= 0) return s;
            return s.substring(0, s.offsetByCodePoints(0, total - n));
        }
    }

    private static double computeLevel(float[] samples) {
        if (samples.length == 0) return 0;
        double power = 0;
        for (float s : samples) power += s * s;
        return Math.min(1, Math.sqrt(power / samples.length) * 3);
    }

    private static final class AudioBatch {
        final float[] samples;
        final boolean speech;
        final int trailingSilence;
        final boolean finalTail;
        AudioBatch(float[] samples, boolean speech, int trailingSilence, boolean finalTail) {
            this.samples = samples; this.speech = speech; this.trailingSilence = trailingSilence;
            this.finalTail = finalTail;
        }
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

        synchronized AudioBatch pollSamples(AtomicLong generation) throws Exception {
            while ((pcmQueue.isEmpty() || stopRequested) && !readerDone && !discarded && generation.get() == owner) {
                wait();
            }
            if (discarded || generation.get() != owner) return null;
            if (overflowed) {
                throw new IOException("Offline speech processing overloaded");
            }
            if (!pcmQueue.isEmpty()) {
                int count = 0, trailingSilence = 0;
                boolean speech = false;
                for (float[] chunk : pcmQueue) {
                    count += chunk.length;
                    boolean voiced = computeLevel(chunk) >= 0.01;
                    speech |= voiced;
                    trailingSilence = voiced ? 0 : trailingSilence + chunk.length;
                }
                float[] batch = new float[count];
                int offset = 0;
                while (!pcmQueue.isEmpty()) {
                    float[] chunk = pcmQueue.removeFirst();
                    System.arraycopy(chunk, 0, batch, offset, chunk.length);
                    offset += chunk.length;
                }
                // Bind stop ownership at the drain boundary, not after copying.
                // A stop racing a taken normal batch cannot turn TWO full
                // inboxes into one unbounded tail in utteranceSamples.
                return new AudioBatch(batch, speech, trailingSilence, stopRequested && readerDone);
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
            if (recognizer != null) {
                recognizer.release();
                recognizer = null;
            }
        });
        worker.shutdown();
    }
}
