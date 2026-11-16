package com.imcodes.speech;

import java.util.Arrays;

/**
 * Pure-Java Whisper-compatible log-mel spectrogram extractor for Qwen3-ASR.
 *
 * Produces [numFrames, 128] row-major features matching HuggingFace's
 * WhisperFeatureExtractor (16kHz, n_fft=400, hop=160, reflect pad=200,
 * periodic Hann window, Slaney mel filterbank, drop trailing frame,
 * dynamic-range clamp [max - 8.0], and (x + 4.0) / 4.0 scaling).
 */
public final class WhisperMelExtractor {
    public static final int SAMPLE_RATE = 16000;
    public static final int N_FFT = 400;
    public static final int HOP_LENGTH = 160;
    public static final int N_MELS = 128;
    public static final int N_BINS = N_FFT / 2 + 1; // 201
    public static final int PAD_LENGTH = N_FFT / 2; // 200
    public static final int MAX_FRAMES = 1200 * SAMPLE_RATE / HOP_LENGTH;

    public static final class MelFeatures {
        public final float[] data;
        public final int numFrames;
        public final int melBins;

        public MelFeatures(float[] data, int numFrames, int melBins) {
            this.data = data;
            this.numFrames = numFrames;
            this.melBins = melBins;
        }
    }

    public static final class IncrementalMelResult {
        public final MelFeatures mel;
        public final int unchangedMelFrames;

        public IncrementalMelResult(MelFeatures mel, int unchangedMelFrames) {
            this.mel = mel;
            this.unchangedMelFrames = unchangedMelFrames;
        }
    }

    private static final int HALF_FFT = N_FFT / 2; // 200
    private static final int CHUNK_FRAMES = 100;

    private final float[] hannWindow;
    // Exploits real-input DFT conjugate symmetry + symmetric periodic Hann window:
    // w[0] == 0 and w[N - n] == w[n] for n = 1..199, halving inner multiply-adds.
    private final float[] cosHalfTable; // [N_BINS][HALF_FFT] for n = 1..200
    private final float[] sinHalfTable; // [N_BINS][HALF_FFT - 1] for n = 1..199
    private final float[] melFilterbank; // [N_MELS][N_BINS]
    private final int[] melStartBin; // inclusive non-zero bin range per mel band
    private final int[] melEndBin;   // exclusive non-zero bin range per mel band

    public WhisperMelExtractor() {
        this.hannWindow = new float[N_FFT];
        for (int n = 0; n < N_FFT; n++) {
            this.hannWindow[n] = (float) (0.5 * (1.0 - Math.cos(2.0 * Math.PI * n / N_FFT)));
        }

        this.cosHalfTable = new float[N_BINS * HALF_FFT];
        this.sinHalfTable = new float[N_BINS * (HALF_FFT - 1)];
        for (int k = 0; k < N_BINS; k++) {
            int cosRow = k * HALF_FFT;
            for (int n = 1; n <= HALF_FFT; n++) {
                double angle = 2.0 * Math.PI * k * n / N_FFT;
                cosHalfTable[cosRow + (n - 1)] = (float) Math.cos(angle);
            }
            int sinRow = k * (HALF_FFT - 1);
            for (int n = 1; n < HALF_FFT; n++) {
                double angle = 2.0 * Math.PI * k * n / N_FFT;
                sinHalfTable[sinRow + (n - 1)] = (float) Math.sin(angle);
            }
        }

        this.melFilterbank = buildSlaneyMelFilterbank();
        this.melStartBin = new int[N_MELS];
        this.melEndBin = new int[N_MELS];
        for (int mel = 0; mel < N_MELS; mel++) {
            int rowOffset = mel * N_BINS;
            int first = N_BINS;
            int last = 0;
            for (int bin = 0; bin < N_BINS; bin++) {
                if (melFilterbank[rowOffset + bin] != 0.0f) {
                    if (bin < first) first = bin;
                    last = bin + 1;
                }
            }
            melStartBin[mel] = first;
            melEndBin[mel] = last;
        }
    }

    private static double hzToMelSlaney(double hz) {
        final double minLogHertz = 1000.0;
        final double minLogMel = 15.0;
        final double logstep = 27.0 / Math.log(6.4);
        if (hz < minLogHertz) {
            return 3.0 * hz / 200.0;
        }
        return minLogMel + Math.log(hz / minLogHertz) * logstep;
    }

    private static double melToHzSlaney(double mel) {
        final double minLogHertz = 1000.0;
        final double minLogMel = 15.0;
        final double logstep = Math.log(6.4) / 27.0;
        if (mel < minLogMel) {
            return 200.0 * mel / 3.0;
        }
        return minLogHertz * Math.exp((mel - minLogMel) * logstep);
    }

    private static float[] buildSlaneyMelFilterbank() {
        double[] fftFreqs = new double[N_BINS];
        for (int i = 0; i < N_BINS; i++) {
            fftFreqs[i] = (double) i * SAMPLE_RATE / N_FFT;
        }

        double melMin = hzToMelSlaney(0.0);
        double melMax = hzToMelSlaney(SAMPLE_RATE / 2.0);
        int nMelPoints = N_MELS + 2;
        double[] filterFreqs = new double[nMelPoints];
        for (int i = 0; i < nMelPoints; i++) {
            double mel = melMin + (double) i * (melMax - melMin) / (nMelPoints - 1);
            filterFreqs[i] = melToHzSlaney(mel);
        }

        float[] bank = new float[N_MELS * N_BINS];
        for (int mel = 0; mel < N_MELS; mel++) {
            double low = filterFreqs[mel];
            double center = filterFreqs[mel + 1];
            double high = filterFreqs[mel + 2];
            double leftDiff = center - low;
            double rightDiff = high - center;
            double enorm = 2.0 / (high - low);
            int rowOffset = mel * N_BINS;
            for (int bin = 0; bin < N_BINS; bin++) {
                double freq = fftFreqs[bin];
                double downSlope = (freq - low) / leftDiff;
                double upSlope = (high - freq) / rightDiff;
                double tri = Math.max(0.0, Math.min(downSlope, upSlope));
                bank[rowOffset + bin] = (float) (tri * enorm);
            }
        }
        return bank;
    }

    static int reflectIndex(int idx, int length) {
        if (length <= 1) return 0;
        int period = 2 * (length - 1);
        int m = idx % period;
        if (m < 0) m += period;
        return m < length ? m : period - m;
    }

    public MelFeatures extract(float[] audio, int length) {
        if (audio == null || length < 2) {
            return new MelFeatures(new float[0], 0, N_MELS);
        }
        int safeLen = Math.min(length, audio.length);
        if (safeLen < 2) {
            return new MelFeatures(new float[0], 0, N_MELS);
        }

        int paddedLen = PAD_LENGTH + safeLen + PAD_LENGTH;
        float[] padded = new float[paddedLen];
        for (int i = 0; i < PAD_LENGTH; i++) {
            padded[i] = audio[reflectIndex(i - PAD_LENGTH, safeLen)];
        }
        System.arraycopy(audio, 0, padded, PAD_LENGTH, safeLen);
        for (int i = 0; i < PAD_LENGTH; i++) {
            padded[PAD_LENGTH + safeLen + i] = audio[reflectIndex(safeLen + i, safeLen)];
        }

        int rawFrames = (paddedLen - N_FFT) / HOP_LENGTH + 1;
        int numFrames = Math.min(rawFrames - 1, MAX_FRAMES);
        if (numFrames < 2) {
            return new MelFeatures(new float[0], 0, N_MELS);
        }

        float[] features = new float[numFrames * N_MELS];
        float[] windowed = new float[N_FFT];
        float[] even = new float[HALF_FFT - 1];
        float[] odd = new float[HALF_FFT - 1];
        float[] power = new float[N_BINS];
        float maxLog = Float.NEGATIVE_INFINITY;

        for (int frame = 0; frame < numFrames; frame++) {
            float frameMax = computeRawFrame(padded, frame, features, frame * N_MELS, windowed, even, odd, power);
            if (frameMax > maxLog) {
                maxLog = frameMax;
            }
        }

        float floor = maxLog - 8.0f;
        for (int i = 0; i < features.length; i++) {
            float clamped = Math.max(features[i], floor);
            features[i] = (clamped + 4.0f) * 0.25f;
        }
        return new MelFeatures(features, numFrames, N_MELS);
    }

    private float computeRawFrame(
        float[] padded,
        int frame,
        float[] out,
        int featOffset,
        float[] windowed,
        float[] even,
        float[] odd,
        float[] power
    ) {
        int srcOffset = frame * HOP_LENGTH;
        for (int n = 0; n < N_FFT; n++) {
            windowed[n] = padded[srcOffset + n] * hannWindow[n];
        }
        for (int n = 1; n < HALF_FFT; n++) {
            float a = windowed[n];
            float b = windowed[N_FFT - n];
            even[n - 1] = a + b;
            odd[n - 1] = a - b;
        }
        float mid = windowed[HALF_FFT]; // hannWindow[0] == 0 so windowed[0] is 0.

        for (int k = 0; k < N_BINS; k++) {
            int cosRow = k * HALF_FFT;
            int sinRow = k * (HALF_FFT - 1);
            float re = ((k & 1) == 0 ? mid : -mid);
            float im = 0.0f;
            for (int i = 0; i < HALF_FFT - 1; i++) {
                re += even[i] * cosHalfTable[cosRow + i];
                im -= odd[i] * sinHalfTable[sinRow + i];
            }
            power[k] = re * re + im * im;
        }

        float frameMax = Float.NEGATIVE_INFINITY;
        for (int mel = 0; mel < N_MELS; mel++) {
            int bankRow = mel * N_BINS;
            int kStart = melStartBin[mel];
            int kEnd = melEndBin[mel];
            float energy = 0.0f;
            for (int k = kStart; k < kEnd; k++) {
                energy += melFilterbank[bankRow + k] * power[k];
            }
            float logVal = (float) Math.log10(Math.max(1e-10f, energy));
            out[featOffset + mel] = logVal;
            if (logVal > frameMax) {
                frameMax = logVal;
            }
        }
        return frameMax;
    }

    /**
     * Stateful streaming Mel extractor that caches un-clamped per-frame log-mel energies across
     * shared audio prefixes (including monotonic growth and trailing trims such as lowest-energy splits)
     * and tracks which leading 100-frame chunks remain bit-identical despite global dynamic-range clamping.
     */
    public final class IncrementalExtractor {
        private static final int CHUNK_SAMPLES = CHUNK_FRAMES * HOP_LENGTH; // 16,000 samples (1.0s)
        private static final int FP_PER_CHUNK = 8;

        private float[] rawLogs = new float[1400 * N_MELS];
        private float[] chunkMinRaw = new float[16];
        private float[] chunkMaxRaw = new float[16];
        private float[] chunkFp = new float[16 * FP_PER_CHUNK];
        private float[] paddedScratch = new float[0];
        private final float[] windowed = new float[N_FFT];
        private final float[] even = new float[HALF_FFT - 1];
        private final float[] odd = new float[HALF_FFT - 1];
        private final float[] power = new float[N_BINS];

        private int cachedSampleLen = 0;
        private int cachedStableFrames = 0;
        private int cachedCompleteChunks = 0;
        private float cachedFloor = Float.NEGATIVE_INFINITY;

        public void reset() {
            cachedSampleLen = 0;
            cachedStableFrames = 0;
            cachedCompleteChunks = 0;
            cachedFloor = Float.NEGATIVE_INFINITY;
        }

        public IncrementalMelResult extract(float[] audio, int length) {
            if (audio == null || length < 2) {
                reset();
                return new IncrementalMelResult(new MelFeatures(new float[0], 0, N_MELS), 0);
            }
            int safeLen = Math.min(length, audio.length);
            if (safeLen < 2) {
                reset();
                return new IncrementalMelResult(new MelFeatures(new float[0], 0, N_MELS), 0);
            }

            int paddedLen = PAD_LENGTH + safeLen + PAD_LENGTH;
            int rawFrames = (paddedLen - N_FFT) / HOP_LENGTH + 1;
            int numFrames = Math.min(rawFrames - 1, MAX_FRAMES);
            if (numFrames < 2) {
                reset();
                return new IncrementalMelResult(new MelFeatures(new float[0], 0, N_MELS), 0);
            }

            int matchedPrefixChunks = countMatchingPrefixChunks(audio, safeLen);
            int reuseFrames = 0;
            if (matchedPrefixChunks > 0) {
                int matchedSamples = matchedPrefixChunks * CHUNK_SAMPLES;
                int maxInvariant = Math.max(0, (matchedSamples - PAD_LENGTH) / HOP_LENGTH + 1);
                // Exclude any right-edge reflect frames if safeLen == matchedSamples.
                if (safeLen < matchedSamples + PAD_LENGTH) {
                    maxInvariant = Math.max(0, (safeLen - PAD_LENGTH) / HOP_LENGTH);
                }
                reuseFrames = Math.min(cachedStableFrames, Math.min(maxInvariant, numFrames));
            } else {
                reset();
            }

            int neededRaw = numFrames * N_MELS;
            if (rawLogs.length < neededRaw) {
                rawLogs = Arrays.copyOf(rawLogs, Math.max(neededRaw, rawLogs.length * 2));
            }
            int numChunks = (numFrames + CHUNK_FRAMES - 1) / CHUNK_FRAMES;
            if (chunkMinRaw.length < numChunks) {
                int newCap = Math.max(numChunks, chunkMinRaw.length * 2);
                chunkMinRaw = Arrays.copyOf(chunkMinRaw, newCap);
                chunkMaxRaw = Arrays.copyOf(chunkMaxRaw, newCap);
                chunkFp = Arrays.copyOf(chunkFp, newCap * FP_PER_CHUNK);
            }

            // Fill padded audio window covering frames [reuseFrames .. numFrames - 1]
            if (paddedScratch.length < paddedLen) {
                paddedScratch = new float[Math.max(paddedLen, paddedScratch.length * 2)];
            }
            int tailPadStart = Math.max(0, reuseFrames * HOP_LENGTH);
            if (tailPadStart < PAD_LENGTH) {
                for (int i = tailPadStart; i < PAD_LENGTH; i++) {
                    paddedScratch[i] = audio[reflectIndex(i - PAD_LENGTH, safeLen)];
                }
            }
            int copyAudioFrom = Math.max(0, tailPadStart - PAD_LENGTH);
            if (copyAudioFrom < safeLen) {
                System.arraycopy(audio, copyAudioFrom, paddedScratch, PAD_LENGTH + copyAudioFrom, safeLen - copyAudioFrom);
            }
            for (int i = 0; i < PAD_LENGTH; i++) {
                paddedScratch[PAD_LENGTH + safeLen + i] = audio[reflectIndex(safeLen + i, safeLen)];
            }

            for (int frame = reuseFrames; frame < numFrames; frame++) {
                computeRawFrame(paddedScratch, frame, rawLogs, frame * N_MELS, windowed, even, odd, power);
            }

            int firstDirtyChunk = reuseFrames / CHUNK_FRAMES;
            float maxLog = Float.NEGATIVE_INFINITY;
            for (int c = 0; c < firstDirtyChunk; c++) {
                if (chunkMaxRaw[c] > maxLog) maxLog = chunkMaxRaw[c];
            }
            for (int c = firstDirtyChunk; c < numChunks; c++) {
                int fStart = c * CHUNK_FRAMES;
                int fEnd = Math.min(numFrames, fStart + CHUNK_FRAMES);
                float cMin = Float.POSITIVE_INFINITY;
                float cMax = Float.NEGATIVE_INFINITY;
                for (int f = fStart; f < fEnd; f++) {
                    int base = f * N_MELS;
                    for (int m = 0; m < N_MELS; m++) {
                        float v = rawLogs[base + m];
                        if (v < cMin) cMin = v;
                        if (v > cMax) cMax = v;
                    }
                }
                chunkMinRaw[c] = cMin;
                chunkMaxRaw[c] = cMax;
                if (cMax > maxLog) maxLog = cMax;
            }

            float newFloor = maxLog - 8.0f;
            int candidateInvariantChunks = Math.min(cachedCompleteChunks, reuseFrames / CHUNK_FRAMES);
            int unchangedChunks = 0;
            while (unchangedChunks < candidateInvariantChunks) {
                if (newFloor != cachedFloor && Math.max(newFloor, cachedFloor) > chunkMinRaw[unchangedChunks]) {
                    break;
                }
                unchangedChunks++;
            }
            int unchangedMelFrames = unchangedChunks * CHUNK_FRAMES;

            float[] features = new float[neededRaw];
            for (int i = 0; i < neededRaw; i++) {
                float clamped = Math.max(rawLogs[i], newFloor);
                features[i] = (clamped + 4.0f) * 0.25f;
            }

            int completeSampleChunks = safeLen / CHUNK_SAMPLES;
            for (int c = 0; c < completeSampleChunks; c++) {
                recordChunkFingerprint(audio, c);
            }
            cachedSampleLen = safeLen;
            cachedStableFrames = Math.min(numFrames, Math.max(0, (safeLen - PAD_LENGTH) / HOP_LENGTH + 1));
            cachedCompleteChunks = numFrames / CHUNK_FRAMES;
            cachedFloor = newFloor;

            return new IncrementalMelResult(new MelFeatures(features, numFrames, N_MELS), unchangedMelFrames);
        }

        private int countMatchingPrefixChunks(float[] audio, int newLen) {
            if (cachedSampleLen < CHUNK_SAMPLES) return 0;
            int sharedCompleteChunks = Math.min(cachedSampleLen, newLen) / CHUNK_SAMPLES;
            int maxChunks = Math.min(sharedCompleteChunks, cachedCompleteChunks);
            int matched = 0;
            for (int c = 0; c < maxChunks; c++) {
                if (!matchesChunkFingerprint(audio, c)) break;
                matched++;
            }
            return matched;
        }

        private void recordChunkFingerprint(float[] audio, int chunkIdx) {
            int baseSample = chunkIdx * CHUNK_SAMPLES;
            int fpBase = chunkIdx * FP_PER_CHUNK;
            int step = CHUNK_SAMPLES / FP_PER_CHUNK;
            for (int i = 0; i < FP_PER_CHUNK; i++) {
                chunkFp[fpBase + i] = audio[baseSample + i * step + (step / 2)];
            }
        }

        private boolean matchesChunkFingerprint(float[] audio, int chunkIdx) {
            int baseSample = chunkIdx * CHUNK_SAMPLES;
            int fpBase = chunkIdx * FP_PER_CHUNK;
            int step = CHUNK_SAMPLES / FP_PER_CHUNK;
            for (int i = 0; i < FP_PER_CHUNK; i++) {
                if (chunkFp[fpBase + i] != audio[baseSample + i * step + (step / 2)]) {
                    return false;
                }
            }
            return true;
        }
    }
}
