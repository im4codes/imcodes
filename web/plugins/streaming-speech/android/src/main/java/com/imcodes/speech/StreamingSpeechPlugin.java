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
import com.k2fsa.sherpa.onnx.OnlineRecognizer;
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig;
import com.k2fsa.sherpa.onnx.OnlineStream;
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

/** Audio never leaves this device. One serial worker owns all native decoder state. */
@CapacitorPlugin(name = "StreamingSpeech", permissions = {
    @Permission(alias = "speechRecognition", strings = { Manifest.permission.RECORD_AUDIO })
})
public class StreamingSpeechPlugin extends Plugin {
    private static final int SAMPLE_RATE = 16000;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicLong generation = new AtomicLong();
    private final Object captureLock = new Object();
    private OnlineRecognizer recognizer;
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

    private void decodeAvailable(OnlineRecognizer recognizer, OnlineStream stream) {
        while (recognizer.isReady(stream)) recognizer.decode(stream);
    }

    @PluginMethod
    public void available(PluginCall call) {
        boolean ready = true;
        for (String name : new String[] { "encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx", "tokens.txt", "bpe.vocab", "hotwords.txt" }) {
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
            recorder = audio;
            listening = true;
            state("started");
            call.resolve();
            worker.execute(() -> capture(call, owner, audio));
        }
    }

    private void capture(PluginCall call, long owner, AudioRecord audio) {
        OnlineRecognizer recognizer = null;
        OnlineStream stream = null;
        String committed = "", last = "";
        try {
            if (generation.get() != owner) return;
            recognizer = ensureRecognizer();
            stream = recognizer.createStream("");
            // Half-second left-context padding establishes the acoustic alignment baseline.
            stream.acceptWaveform(new float[SAMPLE_RATE / 2], SAMPLE_RATE);
            decodeAvailable(recognizer, stream);
            short[] pcm = new short[1600]; // 100ms chunks; drains buffered warmup audio at CPU speed.
            while (generation.get() == owner) {
                int count = audio.read(pcm, 0, pcm.length, AudioRecord.READ_BLOCKING);
                if (count <= 0) {
                    if (generation.get() != owner) break;
                    throw new IOException("Microphone read failed: " + count);
                }
                float[] samples = new float[count]; double power = 0;
                for (int i = 0; i < count; i++) { samples[i] = pcm[i] / 32768.0f; power += samples[i] * samples[i]; }
                JSObject level = new JSObject(); level.put("level", Math.min(1, Math.sqrt(power / count) * 3));
                notifyListeners("audioLevel", level);
                stream.acceptWaveform(samples, SAMPLE_RATE);
                decodeAvailable(recognizer, stream);
                String text = recognizer.getResult(stream).getText().trim();
                String full = join(committed, text);
                if (!full.equals(last)) { partial(full, false); last = full; }
                if (recognizer.isEndpoint(stream)) {
                    // Reset keeps transducer encoder context; a fresh stream prevents
                    // the next utterance from losing its first words after a pause.
                    OnlineStream next = recognizer.createStream("");
                    // Half-second left-context padding establishes the acoustic alignment baseline.
                    next.acceptWaveform(new float[SAMPLE_RATE / 2], SAMPLE_RATE);
                    decodeAvailable(recognizer, next);
                    stream.release();
                    stream = next;
                    committed = full;
                }
            }
        } catch (Exception | LinkageError e) {
            if (generation.get() == owner) {
                JSObject error = new JSObject(); error.put("message", "Offline speech interrupted");
                notifyListeners("recognitionError", error);
            }
        } finally {
            // Stop may interrupt a blocking read: drain text even on that path.
            if (stream != null && recognizer != null) {
                try {
                    // One second covers the transducer's final right-context window.
                    stream.acceptWaveform(new float[SAMPLE_RATE], SAMPLE_RATE);
                    stream.inputFinished();
                    decodeAvailable(recognizer, stream);
                    partial(join(committed, recognizer.getResult(stream).getText().trim()), true);
                } catch (Exception | LinkageError ignored) { /* still release microphone/stream */ }
            }
            synchronized (captureLock) {
                if (audio != null) {
                    try { audio.stop(); } catch (IllegalStateException ignored) { }
                    audio.release();
                }
                if (recorder == audio) recorder = null;
                listening = false;
            }
            if (stream != null) stream.release();
            state("stopped");
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
    private void cancelCapture() {
        generation.incrementAndGet();
        synchronized (captureLock) {
            if (recorder != null) try { recorder.stop(); } catch (IllegalStateException ignored) { }
        }
    }
    @PluginMethod
    public void stop(PluginCall call) {
        cancelCapture();
        worker.execute(call::resolve); // Capture finally/decoder release precede acknowledgement.
    }
    @Override protected void handleOnPause() { cancelCapture(); }
    @Override protected void handleOnDestroy() {
        cancelCapture();
        worker.execute(() -> {
            if (recognizer != null) {
                recognizer.release();
                recognizer = null;
            }
        });
        worker.shutdown();
    }
}
