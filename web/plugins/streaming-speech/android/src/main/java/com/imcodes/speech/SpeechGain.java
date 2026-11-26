package com.imcodes.speech;

/**
 * Adaptive acoustic noise-floor gating, 125 Hz 2-pole HPF pitch-periodicity VAD,
 * and soft-knee limiting at strict unity gain (1.0f) for 16 kHz mono PCM.
 * Pure Java with zero Android dependencies so DSP/VAD invariants run directly on host JVM.
 */
public final class SpeechGain {
    public static final int SAMPLE_RATE = 16000;
    public static final float TARGET_RMS = 0.16f;
    public static final float BASELINE_GAIN = 1.0f;
    public static final float MIN_GAIN = 1.0f;
    public static final float MAX_GAIN = 1.0f;
    public static final float SOFT_KNEE = 0.75f;
    public static final float SOFT_HEADROOM = 0.24f; // SOFT_KNEE + SOFT_HEADROOM = 0.99 < 1.0
    public static final float MIN_NOISE_FLOOR_RMS = 0.0006f;
    public static final float INITIAL_NOISE_FLOOR_RMS = 0.00075f;
    public static final float MAX_NOISE_FLOOR_RMS = 0.015f;
    public static final float MAX_NOISE_CEILING_RMS = 0.018f;
    public static final float MIN_SPEECH_GATE_RMS = 0.0014f;
    public static final float MAX_SPEECH_GATE_RMS = 0.0018f;
    public static final float INITIAL_NOISE_FLOOR = INITIAL_NOISE_FLOOR_RMS;
    public static final float MAX_NOISE_FLOOR = MAX_NOISE_FLOOR_RMS;
    public static final float NOISE_FLOOR_TRACK_CEILING = MAX_NOISE_CEILING_RMS;
    public static final float NOISE_FLOOR_ALPHA = 0.10f;
    public static final float ATTACK_UP_ALPHA = 0.85f;
    public static final float RELEASE_DOWN_ALPHA = 0.90f;
    public static final float IDLE_DECAY_ALPHA = 0.25f;
    public static final float VOICED_RAW_RMS_FLOOR = 0.0012f;
    public static final float VOICED_NOISE_MULTIPLIER = 1.75f;
    public static final float VOICED_BOOSTED_RMS_FLOOR = 0.0012f;
    public static final float UNPITCHED_SPEECH_RMS_FLOOR = 0.05f;
    public static final float STATIONARY_HOLD_SECONDS = 0.22f;
    public static final float NOISE_FLOOR_ATTACK_TAU = 0.12f;
    public static final float NOISE_FLOOR_RELEASE_TAU = 0.25f;
    public static final int ANALYSIS_SUBFRAME_SAMPLES = 400; // 25 ms @ 16 kHz keeps tracker chunk-size invariant
    public static final float HPF_CUTOFF_HZ = 125.0f;
    private static final float HPF_ALPHA = (float) (1.0 / (1.0 + 2.0 * Math.PI * HPF_CUTOFF_HZ / SAMPLE_RATE));
    public static final float MIN_SPEECH_BAND_RATIO = 0.50f;
    public static final float MIN_PITCH_PERIODICITY = 0.55f;
    public static final float NOISE_ADAPT_MAX_PITCH_PERIODICITY = 0.72f;
    public static final int PITCH_LAG_MIN = 40;   // 400 Hz @ 16 kHz
    public static final int PITCH_LAG_MAX = 200;  // 80 Hz @ 16 kHz
    public static final int PITCH_LAG_STEP = 2;
    public static final double VAD_LEVEL_THRESHOLD = 0.0018;
    public static final double LEVEL_SCALE = 1.0;

    public static final class Result {
        public final double level;
        public final float rawRMS;
        public final float boostedRMS;
        public final boolean anyVoiced;
        public final boolean lastVoiced;
        public final int trailingUnvoicedSamples;
        public final int voicedSamples;
        public final float noiseFloorRMS;

        public Result(
            double level,
            float rawRMS,
            float boostedRMS,
            boolean anyVoiced,
            boolean lastVoiced,
            int trailingUnvoicedSamples,
            int voicedSamples,
            float noiseFloorRMS
        ) {
            this.level = level;
            this.rawRMS = rawRMS;
            this.boostedRMS = boostedRMS;
            this.anyVoiced = anyVoiced;
            this.lastVoiced = lastVoiced;
            this.trailingUnvoicedSamples = trailingUnvoicedSamples;
            this.voicedSamples = voicedSamples;
            this.noiseFloorRMS = noiseFloorRMS;
        }
    }

    private float currentGain = BASELINE_GAIN;
    private float noiseFloor = INITIAL_NOISE_FLOOR_RMS;
    private float prevSubframeRMS = 0.0f;
    private float stationaryAnchorRMS = 0.0f;
    private float stationaryDuration = 0.0f;
    private float hpfPrevX = 0.0f;
    private float hpfStage1Y = 0.0f;
    private float hpfStage2PrevX = 0.0f;
    private float hpfStage2Y = 0.0f;
    private final float[] hpHistory = new float[ANALYSIS_SUBFRAME_SAMPLES];
    private int hpHistoryCount = 0;
    private final double[] hpPrefixSq = new double[ANALYSIS_SUBFRAME_SAMPLES + 1];

    public float getCurrentGain() {
        return currentGain;
    }

    public float getNoiseFloor() {
        return noiseFloor;
    }

    public double processChunk(float[] samples) {
        return processChunk(samples, samples == null ? 0 : samples.length);
    }

    /**
     * Conditions {@code samples[0..count-1]} in place and returns normalized HUD audio level [0, 1].
     */
    public double processChunk(float[] samples, int count) {
        return processDetailed(samples, count).level;
    }

    /**
     * Conditions {@code samples[0..count-1]} in place at unity gain (1.0f) and returns acoustic VAD + noise floor details.
     */
    public Result processDetailed(float[] samples, int count) {
        if (samples == null || count <= 0) {
            return new Result(0.0, 0.0f, 0.0f, false, false, 0, 0, noiseFloor);
        }
        int n = Math.min(count, samples.length);
        if (n <= 0) {
            return new Result(0.0, 0.0f, 0.0f, false, false, 0, 0, noiseFloor);
        }

        float overallRawRMS = rms(samples, 0, n);
        boolean anyVoiced = false;
        boolean lastVoiced = false;
        int trailingUnvoiced = 0;
        int voicedSamples = 0;

        int pos = 0;
        while (pos < n) {
            int end = Math.min(n, pos + ANALYSIS_SUBFRAME_SAMPLES);
            int subCount = end - pos;
            boolean voiced = processSubframe(samples, pos, subCount);
            anyVoiced |= voiced;
            lastVoiced = voiced;
            if (voiced) {
                voicedSamples += subCount;
                trailingUnvoiced = 0;
            } else {
                trailingUnvoiced += subCount;
            }
            pos = end;
        }

        float overallBoostedRMS = rms(samples, 0, n);
        double level = Math.min(1.0, overallBoostedRMS * LEVEL_SCALE);
        return new Result(
            Double.isFinite(level) ? level : 0.0,
            overallRawRMS,
            overallBoostedRMS,
            anyVoiced,
            lastVoiced,
            trailingUnvoiced,
            voicedSamples,
            noiseFloor
        );
    }

    private boolean processSubframe(float[] samples, int start, int count) {
        float dt = (float) count / (float) SAMPLE_RATE;
        int cap = ANALYSIS_SUBFRAME_SAMPLES;
        int writeStart;
        if (count >= cap) {
            writeStart = 0;
            hpHistoryCount = cap;
        } else {
            int keep = Math.min(hpHistoryCount, cap - count);
            if (keep > 0) {
                int shift = hpHistoryCount - keep;
                for (int i = 0; i < keep; i++) {
                    hpHistory[i] = hpHistory[shift + i];
                }
            }
            writeStart = keep;
            hpHistoryCount = keep + count;
        }

        double sumSqRaw = 0.0;
        double sumSqHp = 0.0;
        float alpha = HPF_ALPHA;
        int hpOffset = count >= cap ? (count - cap) : 0;
        for (int i = 0; i < count; i++) {
            float s = samples[start + i];
            float x = Float.isFinite(s) ? s : 0.0f;
            sumSqRaw += (double) x * x;

            float s1 = alpha * (hpfStage1Y + x - hpfPrevX);
            hpfPrevX = x;
            hpfStage1Y = s1;
            float s2 = alpha * (hpfStage2Y + s1 - hpfStage2PrevX);
            hpfStage2PrevX = s1;
            hpfStage2Y = s2;
            sumSqHp += (double) s2 * s2;
            if (i >= hpOffset && (writeStart + i - hpOffset) < cap) {
                hpHistory[writeStart + i - hpOffset] = s2;
            }
        }
        float rawRMS = (float) Math.sqrt(sumSqRaw / count);
        float hpRMS = (float) Math.sqrt(sumSqHp / count);
        float hpRatio = rawRMS > 1e-7f ? (hpRMS / rawRMS) : 0.0f;
        float pitch = hpRatio >= MIN_SPEECH_BAND_RATIO ? hpPitchPeriodicity() : 0.0f;
        updateNoiseFloor(rawRMS, hpRatio, pitch, dt);

        // Preserve clean native microphone PCM at unity gain (1.0f) with finite sanitize + soft-knee limiting only.
        currentGain = BASELINE_GAIN;
        double sumSqOut = 0.0;
        for (int i = 0; i < count; i++) {
            float y = softLimit(samples[start + i]);
            samples[start + i] = y;
            sumSqOut += (double) y * y;
        }
        float outputRMS = (float) Math.sqrt(sumSqOut / count);
        float minSpeechFloor = Math.max(VOICED_RAW_RMS_FLOOR, noiseFloor * VOICED_NOISE_MULTIPLIER);
        boolean amplitudeVoiced = rawRMS >= minSpeechFloor && outputRMS >= VOICED_BOOSTED_RMS_FLOOR;
        boolean speechLike = rawRMS >= UNPITCHED_SPEECH_RMS_FLOOR
            || (hpRatio >= MIN_SPEECH_BAND_RATIO && pitch >= MIN_PITCH_PERIODICITY);
        return amplitudeVoiced && speechLike;
    }

    private float hpPitchPeriodicity() {
        int n = hpHistoryCount;
        if (n < ANALYSIS_SUBFRAME_SAMPLES) {
            return 0.0f;
        }
        hpPrefixSq[0] = 0.0;
        for (int i = 0; i < n; i++) {
            double v = hpHistory[i];
            hpPrefixSq[i + 1] = hpPrefixSq[i] + v * v;
        }
        double totalEndSq = hpPrefixSq[n];
        double best = 0.0;
        for (int lag = PITCH_LAG_MIN; lag <= PITCH_LAG_MAX; lag += PITCH_LAG_STEP) {
            int m = n - lag;
            double e0 = hpPrefixSq[m];
            double e1 = totalEndSq - hpPrefixSq[lag];
            double prod = e0 * e1;
            if (prod > 1e-18) {
                double num = 0.0;
                for (int i = 0; i < m; i++) {
                    num += (double) hpHistory[i] * hpHistory[i + lag];
                }
                double r = num / Math.sqrt(prod);
                if (r > best) {
                    best = r;
                }
            }
        }
        return (float) best;
    }

    private void updateNoiseFloor(float rawRMS, float hpRatio, float pitch, float dt) {
        if (!Float.isFinite(rawRMS) || rawRMS <= 1e-6f) {
            return;
        }
        if (rawRMS > MAX_NOISE_CEILING_RMS) {
            stationaryDuration = 0.0f;
            stationaryAnchorRMS = 0.0f;
            prevSubframeRMS = rawRMS;
            return;
        }
        if (rawRMS < noiseFloor) {
            float alpha = 1.0f - (float) Math.exp(-dt / NOISE_FLOOR_RELEASE_TAU);
            noiseFloor = Math.max(MIN_NOISE_FLOOR_RMS, noiseFloor + (rawRMS - noiseFloor) * alpha);
        }
        boolean isEnvelopeCandidate;
        if (prevSubframeRMS <= 0.0f || hpHistoryCount < ANALYSIS_SUBFRAME_SAMPLES) {
            isEnvelopeCandidate = false;
            prevSubframeRMS = rawRMS;
            stationaryAnchorRMS = rawRMS;
            stationaryDuration = 0.0f;
        } else {
            float ratio = rawRMS / prevSubframeRMS;
            boolean anchorOk = stationaryAnchorRMS <= 0.0f
                || (rawRMS >= stationaryAnchorRMS * 0.58f && rawRMS <= stationaryAnchorRMS * 1.72f);
            if (ratio >= 0.65f && ratio <= 1.54f && anchorOk) {
                isEnvelopeCandidate = true;
                prevSubframeRMS += (rawRMS - prevSubframeRMS) * 0.35f;
                if (stationaryAnchorRMS <= 0.0f) {
                    stationaryAnchorRMS = rawRMS;
                }
            } else {
                isEnvelopeCandidate = false;
                stationaryDuration = 0.0f;
                prevSubframeRMS = rawRMS;
                stationaryAnchorRMS = rawRMS;
            }
        }
        if (!isEnvelopeCandidate) {
            return;
        }
        // Require sustained vocal harmonic clarity before exempting stationary low-level audio from
        // ambient noise adaptation; room/fan hum with moderate 25ms autocorrelation still adapts.
        if (hpRatio >= MIN_SPEECH_BAND_RATIO && pitch >= NOISE_ADAPT_MAX_PITCH_PERIODICITY) {
            stationaryDuration = 0.0f;
            stationaryAnchorRMS = rawRMS;
            return;
        }
        stationaryDuration += dt;
        if (rawRMS > noiseFloor && stationaryDuration >= STATIONARY_HOLD_SECONDS) {
            float alpha = 1.0f - (float) Math.exp(-dt / NOISE_FLOOR_ATTACK_TAU);
            noiseFloor = Math.min(MAX_NOISE_FLOOR_RMS, noiseFloor + (rawRMS - noiseFloor) * alpha);
        }
    }

    public static float softLimit(float x) {
        if (!Float.isFinite(x)) {
            return 0.0f;
        }
        float abs = Math.abs(x);
        if (abs <= SOFT_KNEE) {
            return x;
        }
        double excess = (abs - SOFT_KNEE) / SOFT_HEADROOM;
        double limited = SOFT_KNEE + SOFT_HEADROOM * Math.tanh(excess);
        float signed = (float) (x < 0 ? -limited : limited);
        if (!Float.isFinite(signed)) {
            return x < 0 ? -0.9999f : 0.9999f;
        }
        return Math.max(-0.9999f, Math.min(0.9999f, signed));
    }

    public static float rms(float[] samples, int start, int count) {
        if (samples == null || count <= 0 || start < 0 || start >= samples.length) {
            return 0.0f;
        }
        int end = Math.min(samples.length, start + count);
        int n = end - start;
        if (n <= 0) {
            return 0.0f;
        }
        double power = 0.0;
        for (int i = start; i < end; i++) {
            float s = samples[i];
            if (!Float.isFinite(s)) {
                continue;
            }
            power += (double) s * s;
        }
        double r = Math.sqrt(power / n);
        return Double.isFinite(r) ? (float) r : 0.0f;
    }

    public static double computeLevel(float[] samples) {
        return computeLevel(samples, samples == null ? 0 : samples.length);
    }

    public static double computeLevel(float[] samples, int count) {
        if (samples == null || count <= 0) {
            return 0.0;
        }
        int n = Math.min(count, samples.length);
        if (n <= 0) {
            return 0.0;
        }
        double power = 0.0;
        for (int i = 0; i < n; i++) {
            float s = samples[i];
            if (!Float.isFinite(s)) {
                continue;
            }
            power += (double) s * s;
        }
        double rms = Math.sqrt(power / n);
        if (!Double.isFinite(rms)) {
            return 0.0;
        }
        return Math.min(1.0, rms * LEVEL_SCALE);
    }

    public static boolean isVoiced(float[] samples) {
        return computeLevel(samples) >= VAD_LEVEL_THRESHOLD;
    }
}
