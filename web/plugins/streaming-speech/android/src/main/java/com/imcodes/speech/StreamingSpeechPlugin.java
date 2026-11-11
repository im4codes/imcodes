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
    private volatile AudioRecord recorder;
    private volatile boolean listening;

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
        if (listening) { call.resolve(); return; }
        long owner = generation.incrementAndGet();
        worker.execute(() -> capture(call, owner));
    }

    private void capture(PluginCall call, long owner) {
        OnlineRecognizer recognizer = null;
        OnlineStream stream = null;
        AudioRecord audio = null;
        boolean started = false;
        String committed = "", last = "";
        try {
            if (generation.get() != owner) { call.reject("Speech start cancelled"); return; }
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
            recognizer = new OnlineRecognizer(getContext().getAssets(), config);
            stream = recognizer.createStream("");
            int min = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (min <= 0) throw new IOException("Microphone format unavailable");
            synchronized (captureLock) {
                if (generation.get() != owner) { call.reject("Speech start cancelled"); return; }
                audio = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min * 2, 6400));
                if (audio.getState() != AudioRecord.STATE_INITIALIZED) throw new IOException("Microphone initialization failed");
                recorder = audio;
                audio.startRecording();
                if (audio.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) throw new IOException("Microphone start failed");
                listening = true;
            }
            started = true;
            state("started"); call.resolve();
            short[] pcm = new short[1600]; // 100ms, no queued/unbounded audio backlog.
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
                while (recognizer.isReady(stream)) recognizer.decode(stream);
                String text = recognizer.getResult(stream).getText().trim();
                String full = join(committed, text);
                if (!full.equals(last)) { partial(full, false); last = full; }
                if (recognizer.isEndpoint(stream)) {
                    committed = full;
                    recognizer.reset(stream);
                }
            }
        } catch (Exception | LinkageError e) {
            if (!started) call.reject("Offline speech could not start", e instanceof Exception ? (Exception) e : new Exception(e));
            else if (generation.get() == owner) {
                JSObject error = new JSObject(); error.put("message", "Offline speech interrupted");
                notifyListeners("recognitionError", error);
            }
        } finally {
            // Stop may interrupt a blocking read: drain text even on that path.
            if (started && stream != null && recognizer != null) {
                try {
                    // One second covers the transducer's final right-context window.
                    stream.acceptWaveform(new float[SAMPLE_RATE], SAMPLE_RATE);
                    stream.inputFinished();
                    while (recognizer.isReady(stream)) recognizer.decode(stream);
                    partial(join(committed, recognizer.getResult(stream).getText().trim()), true);
                } catch (Exception | LinkageError ignored) { /* still release microphone/decoder */ }
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
            if (recognizer != null) recognizer.release();
            if (started) state("stopped");
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
    @Override protected void handleOnDestroy() { cancelCapture(); worker.shutdown(); }
}
