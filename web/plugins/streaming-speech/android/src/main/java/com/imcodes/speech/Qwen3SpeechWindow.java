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
    public static final int STRIDE = SAMPLE_RATE * 3 / 2; // 1.5s of NEW audio per partial decode
    public static final int SEGMENT_CAPACITY = SAMPLE_RATE * 27 / 2; // 13.5s bounded segment (216,000 samples)
    public static final int SPLIT_SEARCH_WINDOW = SAMPLE_RATE * 5 / 2; // 2.5s trailing quiet search band
    public static final int FINAL_SILENCE_PADDING = SAMPLE_RATE * 2 / 10; // 200ms zero padding at final flush
    public static final int UNFIXED_CHUNK_NUM = 2;
    public static final int UNFIXED_TOKEN_NUM = 5;
    public static final int PUNCTUATION_PAUSE = SAMPLE_RATE * 4 / 10; // 400ms
    public static final int VAD_PAUSE = SAMPLE_RATE * 7 / 10; // 700ms

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

    private void advanceSilence(int sliceCount, boolean speech, int trailingSilence, int tailRemaining) {
        if (!speech) {
            silentSamples += sliceCount;
            return;
        }
        int silentEnd = Math.max(0, trailingSilence - tailRemaining);
        silentSamples = silentEnd < sliceCount ? silentEnd : silentSamples + sliceCount;
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
        if (input == null || input.length == 0 || (sampleCount == 0 && !speech)) {
            return;
        }
        RollbackFn rollbackFn = rollbackPrefix != null ? rollbackPrefix : Qwen3SpeechWindow::defaultRollbackPrefix;
        int offset = 0;
        int remaining = input.length;

        while (sampleCount + remaining > SEGMENT_CAPACITY) {
            if (!shouldContinue.getAsBoolean()) throw new CancelledException();
            int takeCount = Math.max(0, SEGMENT_CAPACITY - sampleCount);
            if (takeCount > 0) {
                System.arraycopy(input, offset, samples, sampleCount, takeCount);
                offset += takeCount;
                remaining -= takeCount;
                sampleCount += takeCount;
                newSamples += takeCount;
            }
            advanceSilence(takeCount, speech, trailingSilence, remaining);
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

        System.arraycopy(input, offset, samples, sampleCount, remaining);
        sampleCount += remaining;
        newSamples += remaining;
        advanceSilence(remaining, speech, trailingSilence, 0);

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

    /**
     * Thread-compatible PCM intake inbox matching iOS SpeechInbox:
     * 32s capacity (512,000 samples), 20ms startup warmup drop (320 samples),
     * 50ms audioLevel throttle, and chunk-level VAD metadata.
     */
    public static final class SpeechInbox {
        public static final int LIMIT = SAMPLE_RATE * 320 / 10; // 512,000 samples (~32s)
        public static final int WARMUP_SAMPLES = 320; // 20ms at 16kHz
        public static final long AUDIO_LEVEL_INTERVAL_NS = 50_000_000L; // 50ms
        public static final double VOICED_THRESHOLD = 0.01;

        public static final class Batch {
            public final float[] samples;
            public final boolean speech;
            public final int trailingSilence;

            public Batch(float[] samples, boolean speech, int trailingSilence) {
                this.samples = samples;
                this.speech = speech;
                this.trailingSilence = trailingSilence;
            }
        }

        private final SpeechGain speechGain;
        private final ArrayDeque<float[]> pending = new ArrayDeque<>();
        private int pendingSampleCount = 0;
        private boolean speech = false;
        private int trailingSilence = 0;
        private int warmupRemaining = WARMUP_SAMPLES;
        private Double pendingAudioLevel = null;
        private long lastAudioLevelNs = Long.MIN_VALUE;

        public SpeechInbox() {
            this(null);
        }

        public SpeechInbox(SpeechGain speechGain) {
            this.speechGain = speechGain;
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
            if (speechGain != null) {
                level = speechGain.processChunk(chunk, usable);
            } else {
                double power = 0.0;
                for (float s : chunk) {
                    power += s * s;
                }
                level = Math.min(1.0, Math.sqrt(power / usable) * 3.0);
            }
            pendingAudioLevel = level;
            boolean voiced = level >= VOICED_THRESHOLD;
            speech |= voiced;
            trailingSilence = voiced ? 0 : trailingSilence + usable;

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
            Batch batch = new Batch(combined, speech, trailingSilence);
            pendingSampleCount = 0;
            speech = false;
            trailingSilence = 0;
            return batch;
        }

        public void clear() {
            pending.clear();
            pendingSampleCount = 0;
            speech = false;
            trailingSilence = 0;
            pendingAudioLevel = null;
        }
    }
}
