package com.imcodes.speech;

import java.io.IOException;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/**
 * Pure-Java Token Prefix Rollback segmenter + SpeechInbox matching iOS 576d9242f.
 *
 * Replaces character-level overlap stitching (ROLLBACK_CHARS / overlapText / seamTail)
 * with decoder-conditioned prefixTokens, lowest-energy segment splitting within a 2.5s
 * lookback band at 13.5s capacity, 400/700ms pause VAD, and U+FFFD-safe rollback.
 */
public final class Qwen3SpeechWindow {
    public static final int SAMPLE_RATE = 16000;
    public static final int STRIDE = SAMPLE_RATE * 2; // 2.0s (exact 2x100 mel chunk alignment) of NEW audio per partial decode
    public static final int SEGMENT_CAPACITY = SAMPLE_RATE * 27 / 2; // 13.5s bounded segment (216,000 samples)
    public static final int SPLIT_SEARCH_WINDOW = SAMPLE_RATE * 5 / 2; // 2.5s trailing quiet search band
    public static final int FINAL_SILENCE_PADDING = SAMPLE_RATE * 2 / 10; // 200ms zero padding at final flush
    public static final int UNFIXED_CHUNK_NUM = 2;
    public static final int UNFIXED_TOKEN_NUM = 5;
    public static final int PUNCTUATION_PAUSE = SAMPLE_RATE * 4 / 10; // 400ms
    public static final int VAD_PAUSE = SAMPLE_RATE * 7 / 10; // 700ms
    public static final int ONSET_CONFIRM_SAMPLES = SAMPLE_RATE * 15 / 100; // 150ms sustained speech before locking window
    public static final int ONSET_CLEAR_SILENCE_SAMPLES = SAMPLE_RATE / 10; // 100ms unvoiced gap clears unconfirmed onset
    public static final float ONSET_BYPASS_RMS = 0.05f; // Normal handheld speech opens window immediately
    public static final float MIN_DECODE_WINDOW_RMS = 0.0024f; // Skip decoder call if no 200ms window reaches soft-speech energy
    public static final float MIN_DECODE_NOISE_MULTIPLIER = 1.75f; // Require ~4.9 dB above adapted ambient noise floor
    public static final int SILENCE_RESET_MIN_VOICED_SAMPLES = SAMPLE_RATE / 20; // 50ms voiced continuity required to reset active pause clock
    public static final int DECODE_ENERGY_WINDOW_SAMPLES = SAMPLE_RATE * 2 / 10; // 200ms @ 16 kHz
    public static final int DECODE_ENERGY_HOP_SAMPLES = SAMPLE_RATE / 10; // 100ms hop @ 16 kHz

    public static final class DecodeResult {
        public final String text;
        public final int[] tokens;

        public DecodeResult(String text, int[] tokens) {
            this.text = text != null ? text : "";
            this.tokens = tokens != null ? tokens : new int[0];
        }
    }

    @FunctionalInterface
    public interface DecodeFn {
        DecodeResult decode(float[] samples, int count, int[] prefixTokens);
    }

    @FunctionalInterface
    public interface RollbackFn {
        int[] rollback(int[] tokens, int rollbackCount);
    }

    public static final class CancelledException extends RuntimeException {
        public CancelledException() {
            super("Speech decode cancelled");
        }
    }

    public static final class DecodeException extends RuntimeException {
        public DecodeException(String message) {
            super(message);
        }
    }

    private final float[] samples = new float[SEGMENT_CAPACITY];
    private int sampleCount = 0;
    private String committed = "";
    private String partial = "";
    private int[] activeTokens = new int[0];
    private int chunkCount = 0;
    private int lastDecodedSampleCount = 0;
    private int newSamples = 0;
    private int silentSamples = 0;
    private String lastEmitted = "";
    private float[] pendingOnset = new float[8192];
    private int pendingOnsetCount = 0;
    private int pendingOnsetActiveSamples = 0;
    private int pendingOnsetSilenceSamples = 0;
    private float latestNoiseFloorRMS = SpeechGain.INITIAL_NOISE_FLOOR_RMS;
    private int voicedSinceSilenceSamples = 0;

    private void appendPendingOnset(float[] chunk) {
        if (pendingOnsetCount + chunk.length > pendingOnset.length) {
            int nextCap = Math.max(pendingOnset.length * 2, pendingOnsetCount + chunk.length);
            pendingOnset = Arrays.copyOf(pendingOnset, nextCap);
        }
        System.arraycopy(chunk, 0, pendingOnset, pendingOnsetCount, chunk.length);
        pendingOnsetCount += chunk.length;
    }

    private void clearPendingOnset() {
        pendingOnsetCount = 0;
        pendingOnsetActiveSamples = 0;
        pendingOnsetSilenceSamples = 0;
    }

    private static float rms(float[] samples, int count) {
        int n = Math.min(samples.length, Math.max(0, count));
        if (n <= 0) return 0.0f;
        double sumSq = 0.0;
        for (int i = 0; i < n; i++) {
            float v = samples[i];
            if (Float.isFinite(v)) {
                double dv = v;
                sumSq += dv * dv;
            }
        }
        return (float) Math.sqrt(sumSq / n);
    }

    public static boolean hasDecodableEnergy(float[] audio, int count) {
        return hasDecodableEnergy(audio, count, SpeechGain.INITIAL_NOISE_FLOOR_RMS);
    }

    public static boolean hasDecodableEnergy(float[] audio, int count, float noiseFloorRMS) {
        int n = Math.min(audio.length, Math.max(0, count));
        if (n <= 0) return false;
        float effectiveMinRMS = Math.max(MIN_DECODE_WINDOW_RMS, noiseFloorRMS * MIN_DECODE_NOISE_MULTIPLIER);
        double threshSq = (double) effectiveMinRMS * effectiveMinRMS;
        int win = DECODE_ENERGY_WINDOW_SAMPLES;
        if (n <= win) {
            double sumSq = 0.0;
            for (int i = 0; i < n; i++) {
                float v = audio[i];
                if (Float.isFinite(v)) {
                    double dv = v;
                    sumSq += dv * dv;
                }
            }
            return (sumSq / n) >= threshSq;
        }
        int hop = DECODE_ENERGY_HOP_SAMPLES;
        double prevSum = 0.0;
        int prevCount = 0;
        int pos = 0;
        while (pos < n) {
            int end = Math.min(n, pos + hop);
            double blockSum = 0.0;
            for (int i = pos; i < end; i++) {
                float v = audio[i];
                if (Float.isFinite(v)) {
                    double dv = v;
                    blockSum += dv * dv;
                }
            }
            int blockCount = end - pos;
            int totalCount = prevCount + blockCount;
            if (totalCount > 0 && ((prevSum + blockSum) / totalCount) >= threshSq) {
                return true;
            }
            prevSum = blockSum;
            prevCount = blockCount;
            pos = end;
        }
        int tailStart = Math.max(0, n - win);
        double tailSum = 0.0;
        for (int i = tailStart; i < n; i++) {
            float v = audio[i];
            if (Float.isFinite(v)) {
                double dv = v;
                tailSum += dv * dv;
            }
        }
        return (tailSum / (n - tailStart)) >= threshSq;
    }

    public static int[] defaultRollbackPrefix(int[] tokens, int rollbackCount) {
        if (tokens == null) return new int[0];
        int trim = Math.max(0, rollbackCount);
        if (tokens.length <= trim) return new int[0];
        return Arrays.copyOf(tokens, tokens.length - trim);
    }

    public static int lowestEnergySplitIndex(float[] samples, int sampleCount) {
        return lowestEnergySplitIndex(samples, sampleCount, SPLIT_SEARCH_WINDOW, 1920, 160);
    }

    public static int lowestEnergySplitIndex(
        float[] samples,
        int sampleCount,
        int searchBack,
        int frameSize,
        int hop
    ) {
        if (sampleCount <= frameSize || searchBack <= frameSize) {
            return sampleCount;
        }
        int searchStart = Math.max(sampleCount / 2, sampleCount - searchBack);
        int limit = sampleCount - frameSize;
        if (searchStart > limit) {
            return sampleCount;
        }
        int span = sampleCount - searchStart;
        double[] prefixSq = new double[span + 1];
        for (int idx = 0; idx < span; idx++) {
            double v = samples[searchStart + idx];
            prefixSq[idx + 1] = prefixSq[idx] + v * v;
        }
        int bestStart = limit;
        double minEnergy = Double.POSITIVE_INFINITY;
        double maxEnergy = 0.0;
        for (int pos = searchStart; pos <= limit; pos += hop) {
            int rel = pos - searchStart;
            double energy = prefixSq[rel + frameSize] - prefixSq[rel];
            if (energy < minEnergy) {
                minEnergy = energy;
                bestStart = pos;
            }
            if (energy > maxEnergy) {
                maxEnergy = energy;
            }
        }
        if ((maxEnergy - minEnergy) / frameSize <= 1e-9) {
            return sampleCount;
        }
        return bestStart + frameSize / 2;
    }

    public String getText() {
        return join(committed, partial);
    }

    public String getCommitted() {
        return committed;
    }

    public String getPartial() {
        return partial;
    }

    public int getNewSamples() {
        return newSamples;
    }

    public int getSampleCount() {
        return sampleCount;
    }

    private void advanceSilence(
        int sliceCount,
        boolean speech,
        int trailingSilence,
        int activeInSlice,
        float sliceRMS,
        int tailRemaining
    ) {
        if (!speech) {
            voicedSinceSilenceSamples = 0;
            silentSamples += sliceCount;
            return;
        }
        voicedSinceSilenceSamples += activeInSlice;
        if (sliceRMS < ONSET_BYPASS_RMS && voicedSinceSilenceSamples < SILENCE_RESET_MIN_VOICED_SAMPLES) {
            // Isolated single-subframe (25ms) ambient blip must not reset an active pause clock.
            silentSamples += sliceCount;
            return;
        }
        int silentEnd = Math.max(0, trailingSilence - tailRemaining);
        silentSamples = silentEnd < sliceCount ? silentEnd : silentSamples + sliceCount;
        if (silentEnd >= sliceCount) {
            voicedSinceSilenceSamples = 0;
        }
    }

    public void append(
        float[] input,
        boolean speech,
        int trailingSilence,
        boolean isFinal,
        BooleanSupplier shouldEmitNonFinal,
        BooleanSupplier shouldContinue,
        RollbackFn rollbackPrefix,
        DecodeFn decode,
        Consumer<String> emit
    ) {
        append(
            input,
            speech,
            trailingSilence,
            speech ? (input != null ? input.length : 0) : 0,
            SpeechGain.INITIAL_NOISE_FLOOR_RMS,
            isFinal,
            shouldEmitNonFinal,
            shouldContinue,
            rollbackPrefix,
            decode,
            emit
        );
    }

    public void append(
        float[] input,
        boolean speech,
        int trailingSilence,
        int activeSamples,
        float noiseFloorRMS,
        boolean isFinal,
        BooleanSupplier shouldEmitNonFinal,
        BooleanSupplier shouldContinue,
        RollbackFn rollbackPrefix,
        DecodeFn decode,
        Consumer<String> emit
    ) {
        latestNoiseFloorRMS = noiseFloorRMS;
        if (input == null || input.length == 0) {
            return;
        }
        float[] src;
        if (sampleCount == 0) {
            if (!speech) {
                if (pendingOnsetCount == 0) {
                    return;
                }
                appendPendingOnset(input);
                pendingOnsetSilenceSamples += input.length;
                pendingOnsetActiveSamples = Math.max(0, pendingOnsetActiveSamples - input.length / 2);
                if (pendingOnsetSilenceSamples >= ONSET_CLEAR_SILENCE_SAMPLES || pendingOnsetActiveSamples == 0) {
                    clearPendingOnset();
                }
                return;
            }
            int silentEnd = Math.min(input.length, Math.max(0, trailingSilence));
            int activeInChunk = activeSamples >= 0
                ? Math.min(input.length, activeSamples)
                : Math.max(0, input.length - silentEnd);
            boolean bypassOnset = rms(input, input.length) >= ONSET_BYPASS_RMS;
            if (pendingOnsetCount == 0 && (bypassOnset || activeInChunk >= ONSET_CONFIRM_SAMPLES)) {
                src = input;
            } else {
                appendPendingOnset(input);
                if (activeInChunk > 0) {
                    pendingOnsetActiveSamples += activeInChunk;
                    pendingOnsetSilenceSamples = silentEnd;
                } else {
                    pendingOnsetSilenceSamples += input.length;
                }
                boolean promoted = bypassOnset || pendingOnsetActiveSamples >= ONSET_CONFIRM_SAMPLES;
                if (!promoted) {
                    if (pendingOnsetSilenceSamples >= ONSET_CLEAR_SILENCE_SAMPLES) {
                        clearPendingOnset();
                    }
                    return;
                }
                src = Arrays.copyOf(pendingOnset, pendingOnsetCount);
                clearPendingOnset();
            }
        } else {
            src = input;
        }
        RollbackFn rollbackFn = rollbackPrefix != null ? rollbackPrefix : Qwen3SpeechWindow::defaultRollbackPrefix;
        int activeForSilence = activeSamples >= 0 ? activeSamples : src.length;
        float inputRMS = rms(src, src.length);
        int offset = 0;
        int remaining = src.length;

        while (sampleCount + remaining > SEGMENT_CAPACITY) {
            if (!shouldContinue.getAsBoolean()) throw new CancelledException();
            int takeCount = Math.max(0, SEGMENT_CAPACITY - sampleCount);
            if (takeCount > 0) {
                System.arraycopy(src, offset, samples, sampleCount, takeCount);
                offset += takeCount;
                remaining -= takeCount;
                sampleCount += takeCount;
                newSamples += takeCount;
            }
            advanceSilence(takeCount, speech, trailingSilence, Math.min(takeCount, activeForSilence), inputRMS, remaining);
            int pause = endsSentence(partial) ? PUNCTUATION_PAUSE : VAD_PAUSE;
            if (silentSamples >= pause) {
                evaluate(samples, sampleCount, sampleCount, true, rollbackFn, shouldContinue, decode);
                commitSegment();
            } else {
                splitAtLowestEnergy(rollbackFn, shouldContinue, decode);
            }
            String current = getText();
            if (!isFinal && shouldEmitNonFinal.getAsBoolean() && !current.equals(lastEmitted)) {
                lastEmitted = current;
                emit.accept(current);
            }
        }

        if (remaining <= 0) return;
        if (!shouldContinue.getAsBoolean()) throw new CancelledException();

        System.arraycopy(src, offset, samples, sampleCount, remaining);
        sampleCount += remaining;
        newSamples += remaining;
        advanceSilence(remaining, speech, trailingSilence, Math.min(remaining, activeForSilence), inputRMS, 0);

        if (isFinal || !shouldEmitNonFinal.getAsBoolean()) {
            return;
        }

        int pause = endsSentence(partial) ? PUNCTUATION_PAUSE : VAD_PAUSE;
        boolean endpoint = silentSamples >= pause;
        if (endpoint) {
            evaluate(samples, sampleCount, sampleCount, true, rollbackFn, shouldContinue, decode);
            commitSegment();
            String current = getText();
            if (!current.equals(lastEmitted)) {
                lastEmitted = current;
                emit.accept(current);
            }
        } else if (sampleCount >= SEGMENT_CAPACITY) {
            splitAtLowestEnergy(rollbackFn, shouldContinue, decode);
            String current = getText();
            if (!current.equals(lastEmitted)) {
                lastEmitted = current;
                emit.accept(current);
            }
        } else if (newSamples >= STRIDE) {
            evaluate(samples, sampleCount, sampleCount, true, rollbackFn, shouldContinue, decode);
            String current = getText();
            if (!current.equals(lastEmitted)) {
                lastEmitted = current;
                emit.accept(current);
            }
        }
    }

    public String finish(BooleanSupplier shouldContinue, RollbackFn rollbackPrefix, DecodeFn decode) {
        RollbackFn rollbackFn = rollbackPrefix != null ? rollbackPrefix : Qwen3SpeechWindow::defaultRollbackPrefix;
        if (sampleCount == 0 && pendingOnsetCount > 0) {
            if (pendingOnsetActiveSamples >= ONSET_CONFIRM_SAMPLES || rms(pendingOnset, pendingOnsetCount) >= ONSET_BYPASS_RMS) {
                int copyCount = Math.min(pendingOnsetCount, SEGMENT_CAPACITY);
                System.arraycopy(pendingOnset, 0, samples, 0, copyCount);
                sampleCount = copyCount;
                newSamples = copyCount;
            }
            clearPendingOnset();
        }
        if (newSamples > 0) {
            float[] padded = new float[sampleCount + FINAL_SILENCE_PADDING];
            System.arraycopy(samples, 0, padded, 0, sampleCount);
            evaluate(padded, padded.length, sampleCount, true, rollbackFn, shouldContinue, decode);
        }
        commitSegment();
        return getText();
    }

    private void splitAtLowestEnergy(
        RollbackFn rollbackPrefix,
        BooleanSupplier shouldContinue,
        DecodeFn decode
    ) {
        int cutIndex = lowestEnergySplitIndex(samples, sampleCount);
        int carriedCount = sampleCount - cutIndex;
        float[] carried = carriedCount > 0 ? Arrays.copyOfRange(samples, cutIndex, sampleCount) : new float[0];
        int preCommitSilent = silentSamples;
        if (cutIndex > 0 && (newSamples > 0 || cutIndex != lastDecodedSampleCount)) {
            boolean allowPrefix = cutIndex >= lastDecodedSampleCount;
            evaluate(samples, cutIndex, cutIndex, allowPrefix, rollbackPrefix, shouldContinue, decode);
        }
        commitSegment();
        if (carriedCount > 0) {
            System.arraycopy(carried, 0, samples, 0, carriedCount);
        }
        sampleCount = carriedCount;
        newSamples = carriedCount;
        silentSamples = carriedCount == 0 ? 0 : Math.min(preCommitSilent, carriedCount);
    }

    private void evaluate(
        float[] audio,
        int audioLen,
        int decodedSampleCount,
        boolean allowPrefix,
        RollbackFn rollbackPrefix,
        BooleanSupplier shouldContinue,
        DecodeFn decode
    ) {
        if (!shouldContinue.getAsBoolean()) throw new CancelledException();
        if (!hasDecodableEnergy(audio, audioLen, latestNoiseFloorRMS)) {
            partial = "";
            newSamples = 0;
            return;
        }
        int[] prefixTokens = (allowPrefix && chunkCount >= UNFIXED_CHUNK_NUM)
            ? rollbackPrefix.rollback(activeTokens, UNFIXED_TOKEN_NUM)
            : new int[0];
        DecodeResult result = decode.decode(audio, audioLen, prefixTokens);
        if (result == null) {
            if (!shouldContinue.getAsBoolean()) throw new CancelledException();
            throw new DecodeException("Offline speech decoding failed");
        }
        partial = result.text.trim();
        activeTokens = result.tokens;
        chunkCount++;
        lastDecodedSampleCount = decodedSampleCount;
        newSamples = 0;
    }

    private void commitSegment() {
        committed = getText();
        partial = "";
        activeTokens = new int[0];
        chunkCount = 0;
        lastDecodedSampleCount = 0;
        sampleCount = 0;
        newSamples = 0;
        silentSamples = 0;
        voicedSinceSilenceSamples = 0;
        clearPendingOnset();
    }

    public static boolean endsSentence(String text) {
        if (text == null || text.isEmpty()) return false;
        int cp = text.codePointBefore(text.length());
        return "，、；,;.。！？!?".indexOf(cp) >= 0;
    }

    public static String join(String previous, String next) {
        if (previous == null || previous.isEmpty()) return next != null ? next : "";
        if (next == null || next.isEmpty()) return previous;
        char lastChar = previous.charAt(previous.length() - 1);
        char firstChar = next.charAt(0);
        boolean asciiBoundary = lastChar < 128 && firstChar < 128;
        boolean separated = Character.isWhitespace(lastChar) || Character.isWhitespace(firstChar);
        return previous + (asciiBoundary && !separated ? " " : "") + next;
    }

    public static float[] decodePcm16LittleEndian(byte[] pcm16) {
        if (pcm16 == null || (pcm16.length % 2) != 0) {
            return null;
        }
        int sampleCount = pcm16.length / 2;
        float[] out = new float[sampleCount];
        for (int i = 0; i < sampleCount; i++) {
            int lo = pcm16[i * 2] & 0xff;
            int hi = pcm16[i * 2 + 1] & 0xff;
            short sample = (short) (lo | (hi << 8));
            out[i] = sample / 32768.0f;
        }
        return out;
    }

    public static String transcribeOfflineSamples(
        float[] audio,
        RollbackFn rollbackPrefix,
        DecodeFn decode,
        BooleanSupplier shouldContinue
    ) {
        if (audio == null || audio.length == 0) {
            return "";
        }
        SpeechGain gain = new SpeechGain();
        Qwen3SpeechWindow window = new Qwen3SpeechWindow();
        int chunkSize = STRIDE; // 2s chunks matching Qwen3-ASR stride
        int offset = 0;
        while (offset < audio.length) {
            int end = Math.min(audio.length, offset + chunkSize);
            int len = end - offset;
            float[] slice = new float[len];
            System.arraycopy(audio, offset, slice, 0, len);
            SpeechGain.Result processed = gain.processDetailed(slice, len);
            boolean isLast = end >= audio.length;
            window.append(
                slice,
                processed.anyVoiced || window.sampleCount > 0,
                processed.trailingUnvoicedSamples,
                processed.voicedSamples,
                processed.noiseFloorRMS,
                isLast,
                () -> !isLast && shouldContinue.getAsBoolean(),
                shouldContinue,
                rollbackPrefix,
                decode,
                ignored -> {}
            );
            offset = end;
        }
        return window.finish(shouldContinue, rollbackPrefix, decode);
    }

    /**
     * Thread-compatible PCM intake inbox matching iOS SpeechInbox:
     * 32s capacity (512,000 samples), 20ms startup warmup drop (320 samples),
     * 50ms audioLevel throttle, and chunk-level VAD metadata.
     */
    public static final class SpeechInbox {
        public static final int LIMIT = SAMPLE_RATE * 320 / 10; // 512,000 samples (~32s)
        public static final int WARMUP_SAMPLES = 320; // 20ms at 16kHz
        public static final long AUDIO_LEVEL_INTERVAL_NS = 50_000_000L; // 50ms
        public static final double VOICED_THRESHOLD = 0.0018;

        public static final class Batch {
            public final float[] samples;
            public final boolean speech;
            public final int trailingSilence;
            public final int activeSamples;
            public final float noiseFloorRMS;

            public Batch(float[] samples, boolean speech, int trailingSilence) {
                this(samples, speech, trailingSilence, speech && samples != null ? samples.length : 0, SpeechGain.INITIAL_NOISE_FLOOR_RMS);
            }

            public Batch(float[] samples, boolean speech, int trailingSilence, int activeSamples, float noiseFloorRMS) {
                this.samples = samples;
                this.speech = speech;
                this.trailingSilence = trailingSilence;
                this.activeSamples = activeSamples;
                this.noiseFloorRMS = noiseFloorRMS;
            }
        }

        private final SpeechGain speechGain;
        private final ArrayDeque<float[]> pending = new ArrayDeque<>();
        private int pendingSampleCount = 0;
        private boolean speech = false;
        private int trailingSilence = 0;
        private int activeSamples = 0;
        private boolean lastVoiced = false;
        private int warmupRemaining;
        private Double pendingAudioLevel = null;
        private long lastAudioLevelNs = Long.MIN_VALUE;

        public SpeechInbox() {
            this(null, WARMUP_SAMPLES);
        }

        public SpeechInbox(SpeechGain speechGain) {
            this(speechGain, WARMUP_SAMPLES);
        }

        public SpeechInbox(SpeechGain speechGain, int warmupSamples) {
            this.speechGain = speechGain;
            this.warmupRemaining = Math.max(0, warmupSamples);
        }

        public int getWarmupRemaining() {
            return warmupRemaining;
        }

        public int getPendingSampleCount() {
            return pendingSampleCount;
        }

        public boolean isEmpty() {
            return pending.isEmpty();
        }

        public boolean isLastVoiced() {
            return lastVoiced;
        }

        public float getCurrentNoiseFloorRMS() {
            return speechGain != null ? speechGain.getNoiseFloor() : SpeechGain.INITIAL_NOISE_FLOOR_RMS;
        }

        public boolean offer(float[] input, int length) throws IOException {
            if (input == null || length <= 0) return false;
            int safeLen = Math.min(length, input.length);
            int skip = Math.min(warmupRemaining, safeLen);
            warmupRemaining -= skip;
            int usable = safeLen - skip;
            if (usable <= 0) return false;

            if (usable > LIMIT - pendingSampleCount) {
                throw new IOException("Offline speech processing overloaded");
            }

            float[] chunk = new float[usable];
            System.arraycopy(input, skip, chunk, 0, usable);

            double level;
            boolean anyVoiced;
            boolean chunkLastVoiced;
            int voicedInChunk;
            int trailingUnvoiced;
            if (speechGain != null) {
                SpeechGain.Result res = speechGain.processDetailed(chunk, usable);
                level = res.level;
                anyVoiced = res.anyVoiced;
                chunkLastVoiced = res.lastVoiced;
                voicedInChunk = res.voicedSamples;
                trailingUnvoiced = res.trailingUnvoicedSamples;
            } else {
                double power = 0.0;
                for (float s : chunk) {
                    power += s * s;
                }
                level = Math.min(1.0, Math.sqrt(power / usable));
                anyVoiced = level >= VOICED_THRESHOLD;
                chunkLastVoiced = anyVoiced;
                voicedInChunk = anyVoiced ? usable : 0;
                trailingUnvoiced = anyVoiced ? 0 : usable;
            }
            pendingAudioLevel = level;
            lastVoiced = chunkLastVoiced;
            speech |= anyVoiced;
            activeSamples += voicedInChunk;
            trailingSilence = anyVoiced ? trailingUnvoiced : trailingSilence + usable;

            pending.addLast(chunk);
            pendingSampleCount += usable;
            return true;
        }

        public Double pollAudioLevel(long nowNs) {
            if (warmupRemaining > 0 || pendingAudioLevel == null) {
                return null;
            }
            if (lastAudioLevelNs != Long.MIN_VALUE && (nowNs - lastAudioLevelNs) < AUDIO_LEVEL_INTERVAL_NS) {
                return null;
            }
            Double level = pendingAudioLevel;
            pendingAudioLevel = null;
            lastAudioLevelNs = nowNs;
            return level;
        }

        public Batch take() {
            if (pending.isEmpty()) return null;
            float[] combined = new float[pendingSampleCount];
            int offset = 0;
            while (!pending.isEmpty()) {
                float[] chunk = pending.removeFirst();
                System.arraycopy(chunk, 0, combined, offset, chunk.length);
                offset += chunk.length;
            }
            Batch batch = new Batch(combined, speech, trailingSilence, activeSamples, getCurrentNoiseFloorRMS());
            pendingSampleCount = 0;
            speech = false;
            trailingSilence = 0;
            activeSamples = 0;
            return batch;
        }

        public void clear() {
            pending.clear();
            pendingSampleCount = 0;
            speech = false;
            trailingSilence = 0;
            activeSamples = 0;
            lastVoiced = false;
            pendingAudioLevel = null;
        }
    }
}
