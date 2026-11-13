package com.imcodes.speech;

/**
 * Pure JDK unit tests for {@link SpeechGain} covering quiet speech pickup,
 * loud-speech soft-knee limiting, noise-floor gating, trailing silence flush,
 * and finite sample bounds. Runnable directly via {@code javac}/{@code java}.
 */
public final class SpeechGainTest {
    private static final int CHUNK_SAMPLES = 1600; // 100ms at 16kHz

    public static void main(String[] args) {
        testQuietHandheldSpeechBoostedImmediately();
        testMediumQuietSpeechBoostedAndResponsiveLevel();
        testLoudSpeechAttenuatedAndSoftKneeLimitedWithoutHardClipping();
        testUltraLowRoomFloorDoesNotTriggerFalseVoicedOrInfiniteGain();
        testSilenceAfterSpeechDropsVoicedImmediately();
        testNonFiniteAndEdgeInputsRemainBounded();
        System.out.println("SpeechGainTest: ALL 6 TESTS PASSED");
    }

    private static void testQuietHandheldSpeechBoostedImmediately() {
        SpeechGain gain = new SpeechGain();
        float[] chunk = sineWithRms(CHUNK_SAMPLES, 0.0025f);
        double level = gain.processChunk(chunk, chunk.length);
        double outRms = rms(chunk);

        assertTrue(outRms >= 0.012, "quiet speech should be boosted from 0.0025 into clear range, got " + outRms);
        assertTrue(level >= SpeechGain.VAD_LEVEL_THRESHOLD, "quiet speech first chunk should exceed VAD threshold, got " + level);
        assertTrue(SpeechGain.isVoiced(chunk), "quiet speech (RMS 0.0025) must trigger voiced == true");
        assertAllSamplesBounded(chunk);
    }

    private static void testMediumQuietSpeechBoostedAndResponsiveLevel() {
        SpeechGain gain = new SpeechGain();
        double lastLevel = 0.0;
        for (int i = 0; i < 4; i++) {
            float[] chunk = sineWithRms(CHUNK_SAMPLES, 0.005f);
            lastLevel = gain.processChunk(chunk, chunk.length);
            assertTrue(SpeechGain.isVoiced(chunk), "0.005 RMS speech chunk " + i + " must be voiced");
            assertAllSamplesBounded(chunk);
        }
        assertTrue(lastLevel >= 0.10, "HUD audioLevel should be responsive for quiet-normal speech, got " + lastLevel);
        assertTrue(gain.getCurrentGain() <= SpeechGain.MAX_GAIN + 1e-6f, "gain must stay capped at MAX_GAIN");
    }

    private static void testLoudSpeechAttenuatedAndSoftKneeLimitedWithoutHardClipping() {
        SpeechGain gain = new SpeechGain();
        // Prime to max gain with quiet speech first, then slam with sudden loud speech (RMS 0.85, peak ~1.20)
        gain.processChunk(sineWithRms(CHUNK_SAMPLES, 0.0025f));

        float[] firstLoud = sineWithRms(CHUNK_SAMPLES, 0.85f);
        gain.processChunk(firstLoud, firstLoud.length);
        assertAllSamplesBounded(firstLoud);
        assertTrue(maxAbs(firstLoud) < 1.0f || Math.abs(maxAbs(firstLoud) - 1.0f) <= 1e-6f, "first loud chunk must stay within [-1, 1]");

        float[] steadyLoud = sineWithRms(CHUNK_SAMPLES, 0.70f);
        for (int i = 0; i < 4; i++) {
            steadyLoud = sineWithRms(CHUNK_SAMPLES, 0.70f);
            gain.processChunk(steadyLoud, steadyLoud.length);
            assertAllSamplesBounded(steadyLoud);
        }
        assertTrue(rms(steadyLoud) < 0.35, "sustained loud speech should attenuate cleanly toward target RMS, got " + rms(steadyLoud));
        assertTrue(SpeechGain.isVoiced(steadyLoud), "loud speech must remain voiced");

        // Verify softLimit itself compresses > 1.0 smoothly without flat-top hard clipping
        float high = SpeechGain.softLimit(1.8f);
        float higher = SpeechGain.softLimit(2.4f);
        assertTrue(high > SpeechGain.SOFT_KNEE && high < 1.0f, "softLimit(1.8) should be strictly below 1.0, got " + high);
        assertTrue(higher > high && higher <= 1.0f, "softLimit must remain monotonic instead of flat-topping");
    }

    private static void testUltraLowRoomFloorDoesNotTriggerFalseVoicedOrInfiniteGain() {
        SpeechGain gain = new SpeechGain();
        float[] zeroSilence = new float[CHUNK_SAMPLES];
        double zeroLevel = gain.processChunk(zeroSilence, zeroSilence.length);
        assertTrue(zeroLevel == 0.0, "zero silence level must be 0.0");
        assertTrue(!SpeechGain.isVoiced(zeroSilence), "zero silence must not trigger voiced");

        for (int i = 0; i < 50; i++) {
            float[] roomFloor = sineWithRms(CHUNK_SAMPLES, 0.0012f);
            double level = gain.processChunk(roomFloor, roomFloor.length);
            assertTrue(!SpeechGain.isVoiced(roomFloor), "room floor 0.0012 must not trigger false voiced at chunk " + i + ", level=" + level);
            assertTrue(Float.isFinite(gain.getCurrentGain()) && gain.getCurrentGain() <= SpeechGain.MAX_GAIN,
                "gain must stay finite and bounded during room silence");
            assertAllSamplesBounded(roomFloor);
        }

        // Quiet speech right after sustained room floor must still trigger voiced immediately.
        float[] onsetAfterSilence = sineWithRms(CHUNK_SAMPLES, 0.0020f);
        gain.processChunk(onsetAfterSilence, onsetAfterSilence.length);
        assertTrue(SpeechGain.isVoiced(onsetAfterSilence), "quiet speech (0.0020) after room floor must still trigger voiced");
    }

    private static void testSilenceAfterSpeechDropsVoicedImmediately() {
        SpeechGain gain = new SpeechGain();
        // Sustain quiet speech so gain approaches MAX_GAIN (8x)
        for (int i = 0; i < 6; i++) {
            float[] speech = sineWithRms(CHUNK_SAMPLES, 0.0025f);
            gain.processChunk(speech, speech.length);
            assertTrue(SpeechGain.isVoiced(speech), "speech chunk should be voiced");
        }
        assertTrue(gain.getCurrentGain() > 7.5f, "gain should have ramped near MAX_GAIN");

        // Next chunk drops to room floor (0.0007f): must NOT multiply by 8x into false voiced (0.0056*3 = 0.0168)!
        float[] trailingSilence = sineWithRms(CHUNK_SAMPLES, 0.0007f);
        double level = gain.processChunk(trailingSilence, trailingSilence.length);
        assertTrue(!SpeechGain.isVoiced(trailingSilence),
            "trailing room silence after 8x speech gain must drop voiced == false immediately, got level=" + level);
    }

    private static void testNonFiniteAndEdgeInputsRemainBounded() {
        SpeechGain gain = new SpeechGain();
        assertTrue(gain.processChunk(null, 10) == 0.0, "null array must return 0.0");
        assertTrue(gain.processChunk(new float[0], 0) == 0.0, "empty array must return 0.0");
        assertTrue(SpeechGain.computeLevel(null) == 0.0, "computeLevel(null) must return 0.0");
        assertTrue(!SpeechGain.isVoiced(new float[0]), "empty chunk must not be voiced");

        float[] dirty = new float[] { Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY, 0.05f, -0.05f, 3.0f, -3.0f };
        double level = gain.processChunk(dirty, dirty.length);
        assertTrue(Double.isFinite(level) && level >= 0.0 && level <= 1.0, "level must remain finite in [0,1]");
        assertAllSamplesBounded(dirty);
    }

    private static float[] sineWithRms(int length, float targetRms) {
        float[] out = new float[length];
        double amplitude = targetRms * Math.sqrt(2.0);
        for (int i = 0; i < length; i++) {
            out[i] = (float) (amplitude * Math.sin(2.0 * Math.PI * 220.0 * i / 16000.0));
        }
        return out;
    }

    private static double rms(float[] samples) {
        double power = 0.0;
        for (float s : samples) {
            power += (double) s * s;
        }
        return Math.sqrt(power / samples.length);
    }

    private static float maxAbs(float[] samples) {
        float max = 0.0f;
        for (float s : samples) {
            float a = Math.abs(s);
            if (a > max) max = a;
        }
        return max;
    }

    private static void assertAllSamplesBounded(float[] samples) {
        for (int i = 0; i < samples.length; i++) {
            float s = samples[i];
            assertTrue(Float.isFinite(s), "sample[" + i + "] must be finite, got " + s);
            assertTrue(Math.abs(s) <= 1.0f, "sample[" + i + "] out of [-1, 1] bounds: " + s);
        }
    }

    private static void assertTrue(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError(message);
        }
    }
}
