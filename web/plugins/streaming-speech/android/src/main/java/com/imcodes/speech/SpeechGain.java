package com.imcodes.speech;

/**
 * Adaptive software speech gain, noise-floor gating, and soft-knee limiting for 16kHz mono PCM.
 * Pure Java with zero Android dependencies so DSP/VAD invariants run directly on host JVM.
 */
public final class SpeechGain {
    public static final float TARGET_RMS = 0.16f;
    public static final float BASELINE_GAIN = 4.0f;
    public static final float MIN_GAIN = 0.25f;
    public static final float MAX_GAIN = 8.0f;
    public static final float SOFT_KNEE = 0.75f;
    public static final float MIN_SPEECH_GATE_RMS = 0.0014f;
    public static final float MAX_SPEECH_GATE_RMS = 0.0018f;
    public static final float INITIAL_NOISE_FLOOR = 0.0004f;
    public static final float MAX_NOISE_FLOOR = 0.0009f;
    public static final float NOISE_FLOOR_TRACK_CEILING = 0.0012f;
    public static final float NOISE_FLOOR_ALPHA = 0.10f;
    public static final float ATTACK_UP_ALPHA = 0.85f;
    public static final float RELEASE_DOWN_ALPHA = 0.90f;
    public static final float IDLE_DECAY_ALPHA = 0.25f;
    public static final double VAD_LEVEL_THRESHOLD = 0.01;
    public static final double LEVEL_SCALE = 3.0;

    private float currentGain = BASELINE_GAIN;
    private float noiseFloor = INITIAL_NOISE_FLOOR;

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
                s = 0.0f;
                samples[i] = 0.0f;
            }
            power += (double) s * s;
        }

        double inputRms = Math.sqrt(power / n);
        if (!Double.isFinite(inputRms)) {
            inputRms = 0.0;
        }

        float gateThreshold = clamp(noiseFloor * 2.0f, MIN_SPEECH_GATE_RMS, MAX_SPEECH_GATE_RMS);
        float appliedGain;
        if (inputRms < gateThreshold) {
            // Keep ambient silence/room floor at unity gain so idle hiss does not become false speech
            // or block trailing-silence segment commits.
            if (inputRms > 0.0 && inputRms <= NOISE_FLOOR_TRACK_CEILING) {
                noiseFloor = clamp(
                    noiseFloor + NOISE_FLOOR_ALPHA * ((float) inputRms - noiseFloor),
                    0.0001f,
                    MAX_NOISE_FLOOR
                );
            }
            currentGain = clamp(
                currentGain + IDLE_DECAY_ALPHA * (BASELINE_GAIN - currentGain),
                MIN_GAIN,
                MAX_GAIN
            );
            appliedGain = 1.0f;
        } else {
            float desiredGain = clamp(TARGET_RMS / (float) Math.max(inputRms, 1e-6), MIN_GAIN, MAX_GAIN);
            float alpha = desiredGain > currentGain ? ATTACK_UP_ALPHA : RELEASE_DOWN_ALPHA;
            currentGain = clamp(
                currentGain + alpha * (desiredGain - currentGain),
                MIN_GAIN,
                MAX_GAIN
            );
            appliedGain = currentGain;
        }

        for (int i = 0; i < n; i++) {
            samples[i] = softLimit(samples[i] * appliedGain);
        }
        return computeLevel(samples, n);
    }

    public static float softLimit(float x) {
        if (!Float.isFinite(x)) {
            return 0.0f;
        }
        float abs = Math.abs(x);
        if (abs <= SOFT_KNEE) {
            return x;
        }
        double excess = (abs - SOFT_KNEE) / (1.0 - SOFT_KNEE);
        double limited = SOFT_KNEE + (1.0 - SOFT_KNEE) * Math.tanh(excess);
        float signed = (float) (x < 0 ? -limited : limited);
        if (!Float.isFinite(signed)) {
            return x < 0 ? -1.0f : 1.0f;
        }
        return Math.max(-1.0f, Math.min(1.0f, signed));
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

    private static float clamp(float value, float min, float max) {
        if (!Float.isFinite(value)) {
            return min;
        }
        return Math.max(min, Math.min(max, value));
    }
}
